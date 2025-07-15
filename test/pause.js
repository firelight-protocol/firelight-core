const { loadFixture, time } = require('@nomicfoundation/hardhat-network-helpers')
const { deployVault } = require('./setup/fixtures.js')
const { expect } = require('chai')
const { ethers } = require('hardhat')

describe('Pause test', function() {
  const DECIMALS = 6,
        DEPOSIT_AMOUNT =  ethers.parseUnits('5000', DECIMALS)

  before(async () => {
    
    ({ token_contract, pauser, firelight_vault, users, utils, config } = await loadFixture(
      deployVault.bind({decimals: DECIMALS})
    ))

    // Fund the user with underlying, and approve the vault to spend user's tokens, then perform the deposit
    await utils.mintAndApprove(DEPOSIT_AMOUNT, users[0])
    await firelight_vault.connect(users[0]).deposit(DEPOSIT_AMOUNT / 2n, users[0].address)
    
    // Request a withdraw before the contract is paused
    await (await firelight_vault.connect(users[0]).withdraw(DEPOSIT_AMOUNT / 4n, users[0].address, users[0].address)).wait()
    withdraw_period = (await firelight_vault.currentPeriod()) + 1n
    
  })

  it('reverts when trying to call pause() without PAUSE_ROLE', async () => {
    await expect(firelight_vault.pause()).to.be.revertedWithCustomError(firelight_vault, 'AccessControlUnauthorizedAccount')
  })

  it('successfully pauses the contract if the caller has PAUSE_ROLE', async () => {
    await firelight_vault.connect(pauser).pause()
    expect(await firelight_vault.paused()).to.equal(true)
  })

  it('returns correct values for maxDeposit, maxMint, maxWithdraw and maxRedeem when the contract is paused', async () => {
    const max_deposit = await firelight_vault.maxDeposit(users[0].address),
          max_mint = await firelight_vault.maxMint(users[0].address),
          max_withdraw = await firelight_vault.maxWithdraw(users[0].address),
          max_redeem = await firelight_vault.maxRedeem(users[0].address)

    expect(max_deposit).to.be.equal(0n)
    expect(max_mint).to.be.equal(0n)
    expect(max_withdraw).to.be.equal(0n)
    expect(max_redeem).to.be.equal(0n)
  })

  it('reverts when trying to deposit if the contract is paused', async () => {
    const deposit_attempt = firelight_vault.connect(users[0]).deposit(DEPOSIT_AMOUNT / 2n, users[0].address)
    await expect(deposit_attempt).to.be.revertedWithCustomError(firelight_vault, 'EnforcedPause')
  })

  it('reverts when trying to withdraw if the contract is paused', async () => {
    const request_withdraw_attempt = firelight_vault.connect(users[0]).withdraw(DEPOSIT_AMOUNT / 4n, users[0].address, users[0].address)
    await expect(request_withdraw_attempt).to.be.revertedWithCustomError(firelight_vault, 'EnforcedPause')
  })

  it('reverts when trying to claim a withdraw if the contract is paused', async () => {
    await time.increase(config.period_configuration_duration)
    await expect(firelight_vault.connect(users[0]).claimWithdraw(withdraw_period)).to.be.revertedWithCustomError(firelight_vault, 'EnforcedPause')
  })

  it('reverts when trying to call unpause() without PAUSE_ROLE', async () => {
    await expect(firelight_vault.unpause()).to.be.revertedWithCustomError(firelight_vault, 'AccessControlUnauthorizedAccount')
  })

  it('successfully unpauses the contract if the caller has PAUSE_ROLE', async () => {
    await firelight_vault.connect(pauser).unpause()
    expect(await firelight_vault.paused()).to.equal(false)
  })

  it('allows to complete withdraw once unpaused', async () => {
    await time.increase(config.period_configuration_duration)

    await (await firelight_vault.connect(users[0]).claimWithdraw(withdraw_period)).wait()
    const shares = await firelight_vault.balanceOf(users[0].address)
    const tokens = await token_contract.balanceOf(users[0].address)
    
    expect(shares.toString()).to.equal(DEPOSIT_AMOUNT / 4n)
    expect(tokens.toString()).to.equal(DEPOSIT_AMOUNT / 4n * 3n)  
  })
})