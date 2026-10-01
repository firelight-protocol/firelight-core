const { ethers, network } = require('hardhat')

const REGISTRY_ADDR = '0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019'

// XRP/USD-style feed id (arbitrary 21-byte hex string).
const FEED_ID = '0x' + '11'.repeat(21)
const FEED_ID_ALT = '0x' + '22'.repeat(21)
const FEED_ID_ZERO = '0x' + '00'.repeat(21)

const DESCRIPTION = 'XRP / USD'
const DESCRIPTION_ALT = 'BTC / USD'

// 3 days — sensible cooldown for DEFAULT_ADMIN_ROLE transfers. Long enough
// to notice a hostile rotation, short enough to recover from mistakes.
const ADMIN_TRANSFER_DELAY = 3n * 24n * 60n * 60n

// AccessControl role hashes.
const DEFAULT_ADMIN_ROLE = '0x' + '00'.repeat(32)
const FEED_ADMIN_ROLE = ethers.id('FEED_ADMIN_ROLE')

/**
 * Plants the MockFlareRegistry runtime bytecode at the canonical Flare
 * registry address (same on every Flare-family chain). The contracts
 * under test hard-code that address, so this is the only honest way to
 * mock them out without contract-level seams.
 */
async function plantFlareMocks() {
  const RegistryFactory = await ethers.getContractFactory('MockFlareRegistry')

  const stamp = await RegistryFactory.deploy()
  await stamp.waitForDeployment()
  const code = await ethers.provider.getCode(await stamp.getAddress())

  await network.provider.send('hardhat_setCode', [REGISTRY_ADDR, code])

  const FtsoFactory = await ethers.getContractFactory('MockFtsoV2')
  const ftso = await FtsoFactory.deploy()
  await ftso.waitForDeployment()

  const registry = RegistryFactory.attach(REGISTRY_ADDR)
  await registry.setFtsoV2(await ftso.getAddress())

  return { registry, ftso }
}

/**
 * Deploys the adapter wired the way a production deployment would:
 *
 *   - admin     → DEFAULT_ADMIN_ROLE on the adapter (multisig in prod)
 *   - feedAdmin → FEED_ADMIN_ROLE on the adapter (multisig / hot key)
 */
async function deployAdapterFixture() {
  const [admin, feedAdmin, alice, bob] = await ethers.getSigners()
  const { registry, ftso } = await plantFlareMocks()

  const AdapterFactory = await ethers.getContractFactory('FtsoChainlinkAdapter')
  const adapter = await AdapterFactory.deploy(
    admin.address,
    ADMIN_TRANSFER_DELAY,
    feedAdmin.address,
    FEED_ID,
    DESCRIPTION,
  )
  await adapter.waitForDeployment()

  return {
    adapter,
    ftso,
    registry,
    admin,
    feedAdmin,
    alice,
    bob,
  }
}

module.exports = {
  REGISTRY_ADDR,
  FEED_ID,
  FEED_ID_ALT,
  FEED_ID_ZERO,
  DESCRIPTION,
  DESCRIPTION_ALT,
  ADMIN_TRANSFER_DELAY,
  DEFAULT_ADMIN_ROLE,
  FEED_ADMIN_ROLE,
  plantFlareMocks,
  deployAdapterFixture,
}
