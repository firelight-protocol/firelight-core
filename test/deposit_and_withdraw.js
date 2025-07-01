const { loadFixture, time } = require('@nomicfoundation/hardhat-network-helpers')
const { deployVault } = require('./setup/fixtures.js')
const { expect } = require('chai')
const { ethers } = require('hardhat')

describe('Deposit and Withdraw test', function() {
  const DECIMALS = 6,
        INITIAL_DEPOSIT_LIMIT =  ethers.parseUnits('5000', DECIMALS), // 5k tokens
        TARGET_DEPOSIT_LIMIT = ethers.parseUnits('20000', DECIMALS),  // 20k tokens
        DEPOSIT_AMOUNT = ethers.parseUnits('10000', DECIMALS)         // 10k tokens

  before(async () => {
    ({ token_contract, firelight_vault, limit_updater, users, utils, config } = await loadFixture(
      deployVault.bind(null, { decimals:DECIMALS, initial_deposit_limit: INITIAL_DEPOSIT_LIMIT })
    ))

    // Fund the users with underlying, and approve the vault to spend users' tokens
    await Promise.all(users.map(account => utils.mintAndApprove(DEPOSIT_AMOUNT, account)))
  })

  it('reverts when trying to deposit more than the deposit limit allows', async () => {
    const deposit_attempt = firelight_vault.connect(users[1]).deposit(DEPOSIT_AMOUNT, users[0].address)
    await expect(deposit_attempt).to.be.revertedWithCustomError(firelight_vault, 'DepositLimitExceeded')
  })

  it('reverts when trying to mint more than the deposit limit allows', async () => {
    const deposit_attempt = firelight_vault.connect(users[0]).mint(DEPOSIT_AMOUNT, users[0].address)
    await expect(deposit_attempt).to.be.revertedWithCustomError(firelight_vault, 'DepositLimitExceeded')
  })

  it('increases the deposit limit', async () => {
    await firelight_vault.connect(limit_updater).updateDepositLimit(TARGET_DEPOSIT_LIMIT)

    const deposit_limit = await firelight_vault.depositLimit()
    expect(deposit_limit.toString()).to.equal(TARGET_DEPOSIT_LIMIT)
  })

  it('deposits tokens and receives the expected amount of shares', async () => {
    const shares_preview = await firelight_vault.previewDeposit(DEPOSIT_AMOUNT),
          depositTrx = firelight_vault.connect(users[0]).deposit(DEPOSIT_AMOUNT, users[0])
    
    await expect(depositTrx).to.emit(firelight_vault, 'Deposit').withArgs(
      users[0].address, users[0].address, DEPOSIT_AMOUNT, shares_preview
    )

    const shares = await firelight_vault.balanceOf(users[0].address)
    expect(shares.toString()).to.equal(DEPOSIT_AMOUNT)
  })

  it('mints shares and deducts the expected amount of tokens', async () => {
    const prev_token_bal = await token_contract.balanceOf(users[1]),
          assets_preview = await firelight_vault.previewMint(DEPOSIT_AMOUNT),
          mintedTrx = firelight_vault.connect(users[1]).mint(DEPOSIT_AMOUNT, users[1])
   
    await expect(mintedTrx).to.emit(firelight_vault, 'Deposit').withArgs(
      users[1].address, users[1].address, assets_preview, DEPOSIT_AMOUNT
    )

    const shares = await firelight_vault.balanceOf(users[1].address)
    expect(shares.toString()).to.equal(DEPOSIT_AMOUNT)

    const assets = await token_contract.balanceOf(users[1].address)
    expect(assets).to.equal(prev_token_bal - DEPOSIT_AMOUNT)
  })

  it('reverts when user tries to request withdraw with more than what it owns', async () => {
    const withdraw_request = firelight_vault.connect(users[0]).withdraw(DEPOSIT_AMOUNT + 1n, users[0].address, users[0].address)
    await expect(withdraw_request).to.be.revertedWithCustomError(firelight_vault, 'InsufficientShares')
  })

  it('reverts when user tries to request redeem with more than what it owns', async () => {
    const withdraw_request = firelight_vault.connect(users[1]).redeem(DEPOSIT_AMOUNT + 1n, users[1].address, users[1].address)
    await expect(withdraw_request).to.be.revertedWithCustomError(firelight_vault, 'InsufficientShares')
  })

  it('reverts when trying to complete the withdraw before the next period', async() => {
    const receipt = await (await firelight_vault.connect(users[0]).withdraw(DEPOSIT_AMOUNT, users[0].address, users[0].address)).wait()
    withdraw_period = receipt.logs[1].args[3]

    const withdraw_attempt = firelight_vault.connect(users[0]).claimWithdraw(withdraw_period)
    await expect(withdraw_attempt).to.be.revertedWithCustomError(firelight_vault, 'InvalidPeriod')
  })

  it('reads the user\'s pending withdrawals', async () => {
    const pending_withdrawal_amount = await firelight_vault.withdrawalsOf(withdraw_period, users[0].address)
    expect(pending_withdrawal_amount.toString()).to.equal(DEPOSIT_AMOUNT)
  })

  it('claims withdrawal after the end of next period and receives tokens', async () => {
    await time.increase(config.period_configuration_duration * 2)

    const complete_withdraw_tx = firelight_vault.connect(users[0]).claimWithdraw(withdraw_period)
    await expect(complete_withdraw_tx).to.emit(firelight_vault, 'CompleteWithdraw').withArgs(
      users[0].address, DEPOSIT_AMOUNT, withdraw_period
    )

    const shares = await firelight_vault.balanceOf(users[0].address)
    const tokens = await token_contract.balanceOf(users[0].address)

    expect(shares.toString()).to.equal('0')
    expect(tokens.toString()).to.equal(DEPOSIT_AMOUNT)
  })

  it('reverts when user tries to claim the withdrawal again', async () => {
    await time.increase(config.period_configuration_duration)
    const complete_withdraw = firelight_vault.connect(users[0]).claimWithdraw(withdraw_period)
    await expect(complete_withdraw).to.be.revertedWithCustomError(firelight_vault, 'AlreadyClaimedPeriod')
  })

  it('reverts when user tries to claim a withdraw that does not exist', async () => {
    await time.increase(config.period_configuration_duration)
    const complete_withdraw = firelight_vault.connect(users[0]).claimWithdraw(withdraw_period + 1n)
    await expect(complete_withdraw).to.be.revertedWithCustomError(firelight_vault, 'NoWithdrawalAmount')
  })
})