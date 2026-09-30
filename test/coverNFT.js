const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')
const { expect } = require('chai')
const { ethers, upgrades } = require('hardhat')

const MINTER_ROLE = ethers.id('MINTER_ROLE')
const PAUSER_ROLE = ethers.id('PAUSER_ROLE')
const URI_MANAGER_ROLE = ethers.id('URI_MANAGER_ROLE')

const deployCoverNFT = async () => {
  const [deployer, admin, minter, pauser, uriManager, user1, user2] = await ethers.getSigners()
  const CoverNFTFactory = await ethers.getContractFactory('CoverNFT')

  const coverNFT = await upgrades.deployProxy(
    CoverNFTFactory,
    ['Firelight Cover', 'FLCOVER', 'ipfs://base/', admin.address, minter.address, pauser.address, uriManager.address],
    { kind: 'transparent' }
  )

  return { coverNFT, CoverNFTFactory, deployer, admin, minter, pauser, uriManager, user1, user2 }
}

describe('CoverNFT', function () {
  describe('initialization', () => {
    it('reverts when admin is the zero address', async () => {
      const { CoverNFTFactory } = await loadFixture(deployCoverNFT)
      const uninitialized = await upgrades.deployProxy(CoverNFTFactory, [], { kind: 'transparent', initializer: false })

      await expect(
        uninitialized.initialize('N', 'S', '', ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(uninitialized, 'InvalidAdmin')
    })

    it('grants the optional roles only when the addresses are non-zero', async () => {
      const { coverNFT, admin, minter, pauser, uriManager, CoverNFTFactory } = await loadFixture(deployCoverNFT)

      expect(await coverNFT.hasRole(MINTER_ROLE, minter.address)).to.equal(true)
      expect(await coverNFT.hasRole(PAUSER_ROLE, pauser.address)).to.equal(true)
      expect(await coverNFT.hasRole(URI_MANAGER_ROLE, uriManager.address)).to.equal(true)

      // Optional roles skipped when zero address is provided
      const bare = await upgrades.deployProxy(
        CoverNFTFactory,
        ['N', 'S', '', admin.address, ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress],
        { kind: 'transparent' }
      )
      expect(await bare.hasRole(MINTER_ROLE, minter.address)).to.equal(false)
      expect(await bare.hasRole(PAUSER_ROLE, pauser.address)).to.equal(false)
      expect(await bare.hasRole(URI_MANAGER_ROLE, uriManager.address)).to.equal(false)
    })

    it('reverts when initializing twice', async () => {
      const { coverNFT, admin } = await loadFixture(deployCoverNFT)
      await expect(
        coverNFT.initialize('N', 'S', '', admin.address, ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(coverNFT, 'InvalidInitialization')
    })
  })

  describe('safeMint', () => {
    it('reverts when the caller lacks MINTER_ROLE', async () => {
      const { coverNFT, user1 } = await loadFixture(deployCoverNFT)
      await expect(coverNFT.connect(user1).safeMint(user1.address, 1))
        .to.be.revertedWithCustomError(coverNFT, 'AccessControlUnauthorizedAccount')
    })

    it('mints a token to the receiver when called by the minter', async () => {
      const { coverNFT, minter, user1 } = await loadFixture(deployCoverNFT)
      await coverNFT.connect(minter).safeMint(user1.address, 1)

      expect(await coverNFT.ownerOf(1)).to.equal(user1.address)
      expect(await coverNFT.balanceOf(user1.address)).to.equal(1n)
      expect(await coverNFT.totalSupply()).to.equal(1n)
    })
  })

  describe('setBaseURI', () => {
    it('reverts when the caller lacks URI_MANAGER_ROLE', async () => {
      const { coverNFT, user1 } = await loadFixture(deployCoverNFT)
      await expect(coverNFT.connect(user1).setBaseURI('ipfs://new/'))
        .to.be.revertedWithCustomError(coverNFT, 'AccessControlUnauthorizedAccount')
    })

    it('updates the base URI, emits the event and reflects it in tokenURI', async () => {
      const { coverNFT, minter, uriManager, user1 } = await loadFixture(deployCoverNFT)
      await coverNFT.connect(minter).safeMint(user1.address, 7)

      expect(await coverNFT.tokenURI(7)).to.equal('ipfs://base/7')

      await expect(coverNFT.connect(uriManager).setBaseURI('ipfs://new/'))
        .to.emit(coverNFT, 'BaseURIUpdated')
        .withArgs('ipfs://base/', 'ipfs://new/')

      expect(await coverNFT.tokenURI(7)).to.equal('ipfs://new/7')
    })
  })

  describe('pause / unpause', () => {
    it('reverts when pause or unpause is called without PAUSER_ROLE', async () => {
      const { coverNFT, user1 } = await loadFixture(deployCoverNFT)
      await expect(coverNFT.connect(user1).pause())
        .to.be.revertedWithCustomError(coverNFT, 'AccessControlUnauthorizedAccount')
      await expect(coverNFT.connect(user1).unpause())
        .to.be.revertedWithCustomError(coverNFT, 'AccessControlUnauthorizedAccount')
    })

    it('blocks minting and transfers while paused and restores them on unpause', async () => {
      const { coverNFT, minter, pauser, user1, user2 } = await loadFixture(deployCoverNFT)
      await coverNFT.connect(minter).safeMint(user1.address, 1)

      await coverNFT.connect(pauser).pause()
      expect(await coverNFT.paused()).to.equal(true)

      await expect(coverNFT.connect(minter).safeMint(user1.address, 2))
        .to.be.revertedWithCustomError(coverNFT, 'EnforcedPause')
      await expect(coverNFT.connect(user1).transferFrom(user1.address, user2.address, 1))
        .to.be.revertedWithCustomError(coverNFT, 'EnforcedPause')

      await coverNFT.connect(pauser).unpause()
      expect(await coverNFT.paused()).to.equal(false)

      await coverNFT.connect(user1).transferFrom(user1.address, user2.address, 1)
      expect(await coverNFT.ownerOf(1)).to.equal(user2.address)
    })
  })

  describe('supportsInterface', () => {
    it('supports ERC721, ERC721Enumerable, AccessControl and ERC165', async () => {
      const { coverNFT } = await loadFixture(deployCoverNFT)
      expect(await coverNFT.supportsInterface('0x80ac58cd')).to.equal(true)  // ERC721
      expect(await coverNFT.supportsInterface('0x780e9d63')).to.equal(true)  // ERC721Enumerable
      expect(await coverNFT.supportsInterface('0x7965db0b')).to.equal(true)  // AccessControl
      expect(await coverNFT.supportsInterface('0x01ffc9a7')).to.equal(true)  // ERC165
      expect(await coverNFT.supportsInterface('0xffffffff')).to.equal(false)
    })
  })

  describe('internal overrides (harness)', () => {
    it('resolves the _increaseBalance multiple-inheritance hook', async () => {
      const { user1 } = await loadFixture(deployCoverNFT)
      const harness = await (await ethers.getContractFactory('CoverNFTHarness')).deploy()

      // value == 0 goes through the whole override chain without side effects
      await harness.exposedIncreaseBalance(user1.address, 0)
      expect(await harness.balanceOf(user1.address)).to.equal(0n)

      // ERC721Enumerable forbids batch balance increases
      await expect(harness.exposedIncreaseBalance(user1.address, 1))
        .to.be.revertedWithCustomError(harness, 'ERC721EnumerableForbiddenBatchMint')
    })
  })
})
