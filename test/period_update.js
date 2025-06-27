const { loadFixture, time } = require('@nomicfoundation/hardhat-network-helpers')
const { deployVault } = require('./setup/fixtures.js')
const { expect } = require('chai')
const { ethers } = require('hardhat')

const current_period_duration = async () => {
  const [period_start, period_end] = await Promise.all([
    firelight_vault.currentPeriodStart(),
    firelight_vault.currentPeriodEnd()
  ])
  return Number(period_end - period_start)
}

describe('Period update test', function() {
  let withdraw_period_one, withdraw_period_two
  const DECIMALS = 6,
        INITIAL_DEPOSIT_LIMIT =  ethers.parseUnits('20000', DECIMALS), // 20k tokens
        DEPOSIT_AMOUNT = ethers.parseUnits('10000', DECIMALS),         // 10k tokens
        PERIOD_INIT_DURATION = 172800,                                 // 2 days
        PERIOD_TARGET_DURATION = 604800                                // 1 week

  before(async () => {
    ({ token_contract, firelight_vault, period_init_updater, users, utils, config } = await loadFixture(
      deployVault.bind(null, { decimals:DECIMALS, initial_deposit_limit: INITIAL_DEPOSIT_LIMIT, period_init_duration: PERIOD_INIT_DURATION })
    ))

    // Fund the users with underlying, and approve the vault to spend users' tokens
    await Promise.all(users.map(account => utils.mintAndApprove(DEPOSIT_AMOUNT, account)))

    // Perform a user deposit and a withdraw request for half of the deposit, that should be claimed on period 2 onwards
    await firelight_vault.connect(users[0]).deposit(DEPOSIT_AMOUNT, users[0])
    const withdraw_request = await firelight_vault.connect(users[0]).withdraw(DEPOSIT_AMOUNT / 2n, users[0].address, users[0].address)
    withdraw_period_one = (await withdraw_request.wait()).logs[1].args[3]
  })

  it('should validate initial period duration', async () => {
    expect(await current_period_duration()).to.equal(PERIOD_INIT_DURATION)

    await time.increase(await current_period_duration())

    expect(await firelight_vault.currentPeriod()).to.equal(1)
  })

  it('reverts when providing a duration lesser than or not divisible by SMALLEST_PERIOD_DURATION', async () => {
    const new_epoch = 0,
          duration = 3600
    const small_duration_update_attempt = firelight_vault.connect(period_init_updater).addPeriodInit(new_epoch, duration)
    await expect(small_duration_update_attempt).to.be.revertedWithCustomError(firelight_vault, 'InvalidPeriodInitDuration')

    const not_divisible_duration_update_attempt = firelight_vault.connect(period_init_updater).addPeriodInit(new_epoch, duration * 25)
    await expect(not_divisible_duration_update_attempt).to.be.revertedWithCustomError(firelight_vault, 'InvalidPeriodInitDuration')
  })

  it('reverts when providing an epoch lesser than the next period end, or not divisible by the current period duration', async () => {
    const current_period_end = await firelight_vault.currentPeriodEnd(),
          early_epoch = Number(current_period_end),
          not_divisible_epoch = Number(current_period_end) + await current_period_duration() + 1
    
    const early_epoch_update_attempt = firelight_vault.connect(period_init_updater).addPeriodInit(early_epoch, PERIOD_TARGET_DURATION)
    await expect(early_epoch_update_attempt).to.be.revertedWithCustomError(firelight_vault, 'InvalidPeriodInitEpoch')

    const not_divisible_duration_update_attempt = firelight_vault.connect(period_init_updater).addPeriodInit(not_divisible_epoch, PERIOD_TARGET_DURATION)
    await expect(not_divisible_duration_update_attempt).to.be.revertedWithCustomError(firelight_vault, 'InvalidPeriodInitEpoch')
  })

  it('increases the period duration', async () => {
    // Configure the new period duration to start applying after the end of the next period
    const current_period_end = await firelight_vault.currentPeriodEnd(),
          new_epoch = Number(current_period_end) + await current_period_duration()

    await firelight_vault.connect(period_init_updater).addPeriodInit(new_epoch, PERIOD_TARGET_DURATION)

    const [period_epoch, period_duration, period_start] = await firelight_vault.periodInits(1),
          current_period = await firelight_vault.currentPeriod()

    expect(period_epoch).to.equal(new_epoch)
    expect(period_duration).to.equal(PERIOD_TARGET_DURATION)
    expect(period_start).to.equal(current_period + 2n)

    // Perform a second withdraw for the other half of the deposit, that should be claimed on period 3 onwards
    const withdraw_request = await firelight_vault.connect(users[0]).withdraw(DEPOSIT_AMOUNT / 2n, users[0].address, users[0].address)
    withdraw_period_two = (await withdraw_request.wait()).logs[1].args[3]
  })

  it('reverts when trying to update the period if the last period update is not yet in effect', async () => {
    const current_period_end = await firelight_vault.currentPeriodEnd(),
          new_epoch = Number(current_period_end) + await current_period_duration()

    const update_attempt = firelight_vault.connect(period_init_updater).addPeriodInit(new_epoch, PERIOD_TARGET_DURATION)
    await expect(update_attempt).to.be.revertedWithCustomError(firelight_vault, 'CurrentPeriodInitNotLast')
  })

  it('reverts when trying to complete the withdraw before the next period', async () => {
    const withdraw_attempt_one = firelight_vault.connect(users[0]).claimWithdraw(withdraw_period_one)
    await expect(withdraw_attempt_one).to.be.revertedWithCustomError(firelight_vault, 'InvalidPeriod')

    const withdraw_attempt_two = firelight_vault.connect(users[0]).claimWithdraw(withdraw_period_two)
    await expect(withdraw_attempt_two).to.be.revertedWithCustomError(firelight_vault, 'InvalidPeriod')
  })

  it('allows withdrawal already requested before next period', async () => {
    const pending_withdrawal_amount = await firelight_vault.withdrawalsOf(withdraw_period_one, users[0].address)
    expect(pending_withdrawal_amount.toString()).to.equal(DEPOSIT_AMOUNT / 2n)

    await time.increase(await current_period_duration())
    
    const claim_withdraw_tx = firelight_vault.connect(users[0]).claimWithdraw(withdraw_period_one)
    await expect(claim_withdraw_tx).to.emit(firelight_vault, 'CompleteWithdraw').withArgs(
      users[0].address, DEPOSIT_AMOUNT / 2n, withdraw_period_one
    )

    const shares = await firelight_vault.balanceOf(users[0].address)
    const tokens = await token_contract.balanceOf(users[0].address)

    expect(shares).to.equal(0)
    expect(tokens).to.equal(DEPOSIT_AMOUNT / 2n)
  })

  it('reverts when trying to complete the second withdraw before the next period', async () => {
    const withdraw_attempt = firelight_vault.connect(users[0]).claimWithdraw(withdraw_period_two)
    await expect(withdraw_attempt).to.be.revertedWithCustomError(firelight_vault, 'InvalidPeriod')
  })

  it('should correctly reflect the new period duration', async () => {
    await time.increase(await current_period_duration())

    expect(await current_period_duration()).to.equal(PERIOD_TARGET_DURATION)
  })

  it('allows the second withdrawal after the next period starts', async () => {
    const pending_withdrawal_amount = await firelight_vault.withdrawalsOf(withdraw_period_two, users[0].address)
    expect(pending_withdrawal_amount).to.equal(DEPOSIT_AMOUNT / 2n)
   
    const claim_withdraw_tx = firelight_vault.connect(users[0]).claimWithdraw(withdraw_period_two)
    await expect(claim_withdraw_tx).to.emit(firelight_vault, 'CompleteWithdraw').withArgs(
      users[0].address, DEPOSIT_AMOUNT / 2n, withdraw_period_two
    )

    const shares = await firelight_vault.balanceOf(users[0].address)
    const tokens = await token_contract.balanceOf(users[0].address)

    expect(shares).to.equal(0)
    expect(tokens).to.equal(DEPOSIT_AMOUNT)
  })
})