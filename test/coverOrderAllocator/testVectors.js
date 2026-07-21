const fs = require('fs')
const path = require('path')
const { createRequire } = require('module')
const { expect } = require('chai')
const { ethers, upgrades } = require('hardhat')
const { StandardMerkleTree } = require('@openzeppelin/merkle-tree')

// Load OZ's precompiled TransparentUpgradeableProxy artifact for manual proxy deployment.
const _require = createRequire(__filename)
const TRANSPARENT_PROXY_ARTIFACT = JSON.parse(
  fs.readFileSync(
    _require.resolve(
      '@openzeppelin/upgrades-core/artifacts/@openzeppelin/contracts-v5/proxy/transparent/TransparentUpgradeableProxy.sol/TransparentUpgradeableProxy.json'
    ),
    'utf8'
  )
)

const BPS = 10_000n
const YEAR = 365n * 24n * 3600n

const StatusMap = { PENDING: 0, MATCHED: 1, PARTIAL: 2, CANCELLED: 3 }
const OrderType = { NEW: 0, RENEWAL: 1 }

// All vector amounts (cover, premium, totalAllocated, allocatedCoverPerMarket) are
// authored directly in the canonical 18-decimal USD unit, matching the allocator's
// internal representation. Premium transferred at settle is denormalized to the
// premium token's native decimals (ceil) inside _settleCoverOrder — we mirror that for
// funding / balance compares.
const premium18ToNative = (p18, tokenDecimals) => {
  if (tokenDecimals === 18) return p18
  const divisor = 10n ** BigInt(18 - tokenDecimals)
  return (p18 + divisor - 1n) / divisor
}

const randomSigner = async () => {
  const wallet = ethers.Wallet.createRandom().connect(ethers.provider)
  await ethers.provider.send('hardhat_setBalance', [wallet.address, '0x3635C9ADC5DEA00000'])
  return wallet
}

const abiCoder = ethers.AbiCoder.defaultAbiCoder()

// marketId tuple strings have format `${chainId}:${protocol}:${market}` (matches on-chain struct order).
const resolveMarketId = (tupleStr) => {
  const parts = tupleStr.split(':')
  const chainId = parseInt(parts[0])
  const protocol = parts[1]
  const market = ethers.encodeBytes32String(parts[2])
  const id = ethers.keccak256(abiCoder.encode(['uint64', 'string', 'bytes32'], [chainId, protocol, market]))
  return { id, chainId, protocol, market }
}

// Build merkle tree from expected order results with (marketId, allocatedCover) tuples
const buildMerkleTree = (expectedOrders, scenarioOrders, marketIds) => {
  const matchedOrders = expectedOrders.filter(o => o.status !== 'CANCELLED')
  if (matchedOrders.length === 0) return { tree: null, root: ethers.ZeroHash }

  const leaves = matchedOrders.map(o => {
    const orderMarkets = scenarioOrders[o.orderId].markets
    const tuples = o.allocatedCoverPerMarket.map((v, i) => [
      marketIds[orderMarkets[i].marketId],
      BigInt(v)
    ])
    return [BigInt(o.orderId), tuples]
  })

  const tree = StandardMerkleTree.of(leaves, ['uint256', '(bytes32,uint256)[]'])
  return { tree, root: tree.root }
}

const getProof = (tree, orderId) => {
  if (!tree) return []
  for (const [i, leaf] of tree.entries()) {
    if (leaf[0] === BigInt(orderId)) return tree.getProof(i)
  }
  throw new Error(`Order ${orderId} not found in tree`)
}

// Load all JSON vector files
const vectorsDir = path.join(__dirname, 'vectors')
const vectorFiles = fs.readdirSync(vectorsDir).filter(f => f.endsWith('.json'))

for (const file of vectorFiles) {
  const scenario = JSON.parse(fs.readFileSync(path.join(vectorsDir, file), 'utf-8'))

  describe(`Vector: ${scenario.name}`, function () {
    let allocator, vault, priceFeed, admin, curator, allocatorRole, configAdmin, adminRole, premiumCollector, firstLossBufferWallet, flbTokenAddress
    let tokenContracts = {}
    let tokenAddresses = {}
    let buyerSigners = {}
    let marketIds = {}

    before(async () => {
      const deployer = (await ethers.getSigners())[0]
      admin = await randomSigner()
      curator = await randomSigner()
      allocatorRole = await randomSigner()
      configAdmin = await randomSigner()
      adminRole = await randomSigner()
      premiumCollector = await randomSigner()
      firstLossBufferWallet = await randomSigner()

      // Mock Chainlink-shaped price feed — the allocator now reads the asset price from
      // this adapter at commit time. Per-vector price overrides are applied via
      // priceFeed.setLatestRoundData(...) before each commit.
      const MockPriceFeed = await ethers.getContractFactory('MockPriceFeed')
      priceFeed = await MockPriceFeed.connect(deployer).deploy(8, 10n ** 8n)

      // Deploy mock vault
      const MockVault = await ethers.getContractFactory('MockCoverOrderAllocatorVault')
      vault = await MockVault.connect(deployer).deploy()
      await vault.setCurrentPeriod(scenario.setup.vault.currentPeriod)
      await vault.setTotalAssets(BigInt(scenario.setup.vault.totalAssets))
      // vault.asset() is consulted on allocator initialize for decimals normalization; set
      // to the first premium token (vector tokens are all 6d USDC-like).

      const commitmentPeriod = scenario.setup.vault.currentPeriod + 1
      await vault.setPeriodConfiguration(commitmentPeriod, {
        epoch: 0,
        duration: scenario.setup.vault.periodDuration,
        startingPeriod: commitmentPeriod
      })

      // Deploy mock tokens. Each premiumTokens entry is `{ name, decimals }` — the allocator
      // normalizes inputs to its canonical 18d unit so vectors can mix decimals (USDC 6,
      // DAI 18, etc.) on the same scenario.
      const MockERC20 = await ethers.getContractFactory('MockERC20')
      const tokenSpecs = scenario.setup.premiumTokens
      const seenNames = new Set()
      for (const { name, decimals } of tokenSpecs) {
        if (seenNames.has(name)) continue
        seenNames.add(name)
        const token = await MockERC20.connect(deployer).deploy(`Mock${name}`, `m${name}`, decimals)
        tokenContracts[name] = token
        tokenAddresses[name] = await token.getAddress()
      }

      // Build market structs (order matches the on-chain struct: chainId, protocol, market)
      const markets = scenario.setup.markets.map(m => ({
        chainId: m.chainId,
        protocol: m.protocol,
        market: ethers.encodeBytes32String(m.market)
      }))

      const initialProtocolConcentrations = scenario.setup.initialProtocolConcentrations

      for (const m of scenario.setup.markets) {
        const tupleStr = `${m.chainId}:${m.protocol}:${m.market}`
        const resolved = resolveMarketId(tupleStr)
        marketIds[tupleStr] = resolved.id
      }

      // Deploy CoverNFT proxy
      const CoverNFTFactory = await ethers.getContractFactory('CoverNFT')
      const coverNFT = await upgrades.deployProxy(
        CoverNFTFactory,
        ['Firelight Cover', 'FLCOVER', '', admin.address, deployer.address, ethers.ZeroAddress, ethers.ZeroAddress],
        { kind: 'transparent' }
      )

      // Manually deploy CoverOrderAllocator
      const premiumTokenAddrs = tokenSpecs.map(({ name }) => tokenAddresses[name])
      const flbToken = premiumTokenAddrs[0]
      flbTokenAddress = flbToken
      const flbTokenName = tokenSpecs[0].name
      await vault.setAsset(flbToken)

      // Deploy the oracle and pre-set the price authored in the scenario. The scenario
      // value is expressed with 18 decimals (matching the previous allocator API), so we
      // deploy the aggregator with 18d as well.
      const MockAggregator = await ethers.getContractFactory('MockAggregatorV3')
      priceFeed = await MockAggregator.connect(deployer).deploy(18, BigInt(scenario.matchingParams.assetPriceUSD))

      const CoverOrderAllocatorFactory = await ethers.getContractFactory('CoverOrderAllocator')
      const coverOrderAllocatorImpl = await CoverOrderAllocatorFactory.deploy()
      await coverOrderAllocatorImpl.waitForDeployment()
      const initData = CoverOrderAllocatorFactory.interface.encodeFunctionData('initialize', [{
        vault: await vault.getAddress(),
        premiumCollector: premiumCollector.address,
        coverNFT: await coverNFT.getAddress(),
        priceFeedAdapter: await priceFeed.getAddress(),
        maxPriceAge: 3600,
        premiumTokens: premiumTokenAddrs,
        admin: admin.address,
        adminRole: adminRole.address,
        curatorRole: curator.address,
        allocatorRole: allocatorRole.address,
        configAdminRole: configAdmin.address,
        initialProtocolConcentrations,
        newMarkets: markets,
        capacityConfig: {
          minCAR: scenario.setup.capacityConfig.minCAR,
          firstLossBufferToken: flbToken,
          firstLossBuffer: firstLossBufferWallet.address,
          effectiveLeverage: scenario.matchingParams.effectiveLeverage,
          minOrderMarketCoverAmount: 1,
          divergenceToleranceBps: 0
        },
        priceFeedAdapter: await priceFeed.getAddress(),
        maxPriceAge: 7 * 24 * 3600
      }])

      const ProxyFactory = new ethers.ContractFactory(
        TRANSPARENT_PROXY_ARTIFACT.abi,
        TRANSPARENT_PROXY_ARTIFACT.bytecode,
        deployer
      )

      const proxy = await ProxyFactory.deploy( await coverOrderAllocatorImpl.getAddress(), deployer.address, initData)
      await proxy.waitForDeployment()
      allocator = CoverOrderAllocatorFactory.attach(await proxy.getAddress())

      // Grant MINTER_ROLE on CoverNFT to the allocator
      const MINTER_ROLE = ethers.id('MINTER_ROLE')
      await coverNFT.connect(admin).grantRole(MINTER_ROLE, await allocator.getAddress())

      // Fund first loss buffer (balance authored in FLB token native decimals)
      const flbTokenContract = tokenContracts[flbTokenName]
      await flbTokenContract.mint(firstLossBufferWallet.address, BigInt(scenario.setup.capacityConfig.firstLossBufferBalance))

      // Create buyer signers and fund them
      const allBuyers = new Set(scenario.orders.map(o => o.buyer))
      for (const name of allBuyers) {
        buyerSigners[name] = await randomSigner()
      }

      // Fund buyers with enough for their premiums. The contract computes premium in 18d
      // from the 18d cover, then transfers the native equivalent (ceil) at settle. We must
      // fund exactly that native amount in each premium token's native decimals.
      const tokenDecimalsByName = Object.fromEntries(tokenSpecs.map(t => [t.name, t.decimals]))
      const buyerTokenTotals = {}
      for (const o of scenario.orders) {
        const key = `${o.buyer}:${o.premiumToken}`
        let premium18 = 0n
        const dur = BigInt(scenario.setup.vault.periodDuration)
        for (const m of o.markets) {
          const cover18 = BigInt(m.coverAmount)
          const rate = BigInt(m.coverRateAnnual)
          const num = cover18 * rate * dur
          const den = BPS * YEAR
          premium18 += (num + den - 1n) / den
        }
        const dec = tokenDecimalsByName[o.premiumToken]
        buyerTokenTotals[key] = (buyerTokenTotals[key] || 0n) + premium18ToNative(premium18, dec)
      }

      for (const [key, total] of Object.entries(buyerTokenTotals)) {
        const [buyerName, tokenName] = key.split(':')
        const token = tokenContracts[tokenName]
        const buyer = buyerSigners[buyerName]
        await token.mint(buyer.address, total)
        await token.connect(buyer).approve(await allocator.getAddress(), total)
      }
    })

    it('creates all orders', async () => {
      for (let i = 0; i < scenario.orders.length; i++) {
        const o = scenario.orders[i]
        const marketAllocs = o.markets.map(m => ({
          marketId: marketIds[m.marketId],
          coverRateAnnual: m.coverRateAnnual,
          coverAmount: BigInt(m.coverAmount)
        }))

        await allocator.connect(curator).createCoverOrder(
          buyerSigners[o.buyer].address,
          buyerSigners[o.buyer].address,
          buyerSigners[o.beneficiary].address,
          tokenAddresses[o.premiumToken],
          marketAllocs,
          OrderType[o.orderType]
        )
      }

      expect(await allocator.nextCoverOrderId()).to.equal(scenario.orders.length)
    })

    it('commit + settle produces expected results', async () => {
      const commitmentPeriod = scenario.setup.vault.currentPeriod + 1
      await vault.setCurrentPeriod(scenario.setup.vault.currentPeriod)

      const { tree, root } = buildMerkleTree(scenario.expected.orders, scenario.orders, marketIds)
      const totalAllocated = BigInt(scenario.expected.totalAllocated)
      const settleableOrders = scenario.expected.orders.filter(o => o.status !== 'CANCELLED')

      if (settleableOrders.length > 0) {
        // Set effectiveLeverage in capacityConfig before commit
        await allocator.connect(configAdmin).setCapacityConfig({
          minCAR: scenario.setup.capacityConfig.minCAR,
          firstLossBufferToken: flbTokenAddress,
          firstLossBuffer: firstLossBufferWallet.address,
          effectiveLeverage: scenario.matchingParams.effectiveLeverage,
          minOrderMarketCoverAmount: 1,
          divergenceToleranceBps: 0
        })

        // Commit
        await vault.setCurrentPeriod(commitmentPeriod)
        // Refresh the oracle's updatedAt (hardhat may jump block.timestamp between
        // before() and here, and PriceFeed.getPrice would otherwise revert with
        // PriceFeedTooOld since maxPriceAge = 3600s).
        await priceFeed.setAnswer(BigInt(scenario.matchingParams.assetPriceUSD))
        await allocator.connect(allocatorRole).commitAllocation(commitmentPeriod, root, totalAllocated)

        const commit = await allocator.getAllocationCommitment(commitmentPeriod)
        expect(commit.root).to.equal(root)
        expect(commit.totalDeclaredAllocated).to.equal(totalAllocated)

        // Settle each non-cancelled order (everything to/from the allocator is in 18d)
        for (const exp of settleableOrders) {
          const proof = getProof(tree, exp.orderId)
          const orderMarkets = scenario.orders[exp.orderId].markets
          const tuples = exp.allocatedCoverPerMarket.map((v, i) => ({
            marketId: marketIds[orderMarkets[i].marketId],
            allocatedCover: BigInt(v)
          }))
          await allocator.connect(allocatorRole).settleCoverOrder(
            exp.orderId,
            tuples,
            proof
          )
        }
      }

      // Assert each expected order
      for (const exp of scenario.expected.orders) {
        const order = await allocator.getCoverOrder(exp.orderId)
        if (exp.status === 'CANCELLED') {
          // Cancelled orders are not in the tree — they stay PENDING on-chain
          expect(Number(order.status)).to.be.oneOf([StatusMap.PENDING, StatusMap.CANCELLED],
            `Order ${exp.orderId}: expected PENDING or CANCELLED`)
        } else {
          expect(order.status).to.equal(StatusMap[exp.status],
            `Order ${exp.orderId}: expected status ${exp.status}`)
          expect(order.allocatedCoverAmount).to.equal(BigInt(exp.allocatedCoverAmount),
            `Order ${exp.orderId}: allocatedCoverAmount mismatch`)
          expect(order.allocatedPremiumAmount).to.equal(BigInt(exp.allocatedPremiumAmount),
            `Order ${exp.orderId}: allocatedPremiumAmount mismatch`)

          // Verify per-market allocatedCoverAmount matches the allocated values
          const onChainMarkets = await allocator.getCoverOrderMarkets(exp.orderId)
          for (let i = 0; i < exp.allocatedCoverPerMarket.length; i++) {
            expect(onChainMarkets[i].allocatedCoverAmount).to.equal(BigInt(exp.allocatedCoverPerMarket[i]),
              `Order ${exp.orderId}, market ${i}: allocatedCoverAmount mismatch`)
          }
        }
      }

      // Assert premiumCollector ended up with the expected per-token balance.
      if (scenario.expected.premiumCollectorBalances) {
        for (const [tokenName, expectedBalance] of Object.entries(scenario.expected.premiumCollectorBalances)) {
          const token = tokenContracts[tokenName]
          const actual = await token.balanceOf(premiumCollector.address)
          expect(actual).to.equal(BigInt(expectedBalance),
            `premiumCollector ${tokenName} balance mismatch`)
        }
      }

      // Assert totalSettledCover (in 18d)
      if (settleableOrders.length > 0) {
        const commitAfter = await allocator.getAllocationCommitment(commitmentPeriod)
        const expectedSettledCover = settleableOrders.reduce(
          (sum, o) => sum + BigInt(o.allocatedCoverAmount), 0n
        )
        expect(commitAfter.totalSettledCover).to.equal(expectedSettledCover,
          'totalSettledCover mismatch')
      }
    })
  })
}
