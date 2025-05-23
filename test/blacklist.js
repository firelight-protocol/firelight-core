const { loadFixture, time } = require('@nomicfoundation/hardhat-network-helpers')
const { deployVault } = require('./setup/fixtures.js')
const { expect } = require('chai')
const { ethers } = require('hardhat')

describe('Blacklist test', function() {
  const DECIMALS = 6,
        DEPOSIT_AMOUNT =  ethers.parseUnits('5000', DECIMALS)
        DEPOSIT_LIMIT =  ethers.parseUnits('100000', DECIMALS)
  let checkpoint = 0n

  before(async () => {
    ({ token_contract, blacklister, firelight_vault, users, utils } = await loadFixture(
      deployVault.bind(null, { initial_deposit_limit: DEPOSIT_LIMIT })
    ))

    // Fund the user with underlying, and approve the vault to spend user's tokens, then perform the deposit
    await utils.mintAndApprove(DEPOSIT_LIMIT, users[0])
    await firelight_vault.connect(users[0]).deposit(DEPOSIT_AMOUNT, users[0].address)
  })

  it('reverts if the caller is not granted BLACKLIST_ROLE', async () => {
    const blacklist = firelight_vault.addToBlacklist(users[0].address)
    await expect(blacklist).to.be.revertedWithCustomError(firelight_vault, 'AccessControlUnauthorizedAccount')
  })

  it('successfully adds a bad user to the blacklist', async () => {
    await firelight_vault.connect(blacklister).addToBlacklist(users[0].address)
    const status = await firelight_vault.isBlacklisted(users[0].address)
    expect(status).to.equal(true)
  })

  it('reverts if a blacklisted user tries to transfer', async () => {
    const transfer_attempt = firelight_vault.connect(users[0]).transfer(users[1].address, DEPOSIT_AMOUNT)
    await expect(transfer_attempt).to.be.revertedWithCustomError(firelight_vault, 'BlacklistedAddress')
  })
  
  it('reverts if a blacklisted user attempts to approve a second address and use transferFrom', async () => {
    await firelight_vault.connect(users[0]).approve(users[1].address, DEPOSIT_LIMIT)
    const transfer_from_attempt = firelight_vault.connect(users[1]).transferFrom(users[0].address, users[1].address, DEPOSIT_AMOUNT)
    await expect(transfer_from_attempt).to.be.revertedWithCustomError(firelight_vault, 'BlacklistedAddress')
  })

  it('reverts if a blacklisted user attempts to make deposit', async () => {
    const deposit_attempt = firelight_vault.connect(users[0]).deposit(DEPOSIT_AMOUNT, users[0].address)
    await expect(deposit_attempt).to.be.revertedWithCustomError(firelight_vault, 'BlacklistedAddress')
  })

  it('reverts if a user attempts to redem from a blacklisted user', async () => {
    const redeem_attempt = firelight_vault.connect(users[1]).redeem(DEPOSIT_AMOUNT, users[1].address, users[0].address)
    await expect(redeem_attempt).to.be.revertedWithCustomError(firelight_vault, 'BlacklistedAddress')
  })

  it('reverts if a user attempts to withdraw from a blacklisted user', async () => {
    const withdraw_attempt = firelight_vault.connect(users[1]).withdraw(DEPOSIT_AMOUNT, users[1].address, users[0].address)
    await expect(withdraw_attempt).to.be.revertedWithCustomError(firelight_vault, 'BlacklistedAddress')
  })

  it('reverts if a blacklisted user attempts to claim a withdraw', async () => {
    const withdraw_attempt = firelight_vault.connect(users[0]).claimWithdraw(1)
    await expect(withdraw_attempt).to.be.revertedWithCustomError(firelight_vault, 'BlacklistedAddress')
  })

  it('removes a user from the blacklist', async () => {
    await firelight_vault.connect(blacklister).removeFromBlacklist(users[0].address)
    const status = await firelight_vault.isBlacklisted(users[0].address)
    expect(status).to.equal(false)
  })

  it('allows user to transfer again after removing from blacklist', async () => {
    checkpoint = await time.latest()
   
    await firelight_vault.connect(users[0]).transfer(users[1].address, DEPOSIT_AMOUNT)
    expect(await firelight_vault.balanceOf(users[0].address)).to.be.eq(0n)
    expect(await firelight_vault.balanceOf(users[1].address)).to.be.eq(DEPOSIT_AMOUNT)
  })

  it('logs should show the balance change at the specific time', async () => {
    await time.increase(60) // move forward 1 min 
    const now = await time.latest()

    expect(await firelight_vault.balanceOfAt(users[0].address, checkpoint)).to.be.eq(DEPOSIT_AMOUNT)
    expect(await firelight_vault.balanceOfAt(users[0].address, now)).to.be.eq(0n)

    expect(await firelight_vault.balanceOfAt(users[1].address, checkpoint)).to.be.eq(0n)
    expect(await firelight_vault.balanceOfAt(users[1].address, now)).to.be.eq(DEPOSIT_AMOUNT)
  })
})