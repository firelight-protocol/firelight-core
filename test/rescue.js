const { loadFixture, time } = require('@nomicfoundation/hardhat-network-helpers')
const { deployVault } = require('./setup/fixtures.js')
const { expect } = require('chai')
const { ethers } = require('hardhat')

describe('Rescue test', function() {
  const DECIMALS = 6,
        DEPOSIT_AMOUNT =  ethers.parseUnits('6000', DECIMALS),
        PART_WITHDRAW_AMOUNT =  ethers.parseUnits('2000', DECIMALS),
        DEPOSIT_LIMIT =  ethers.parseUnits('100000', DECIMALS)

  before(async () => {
    ({ token_contract, blocklister, rescuer, firelight_vault, users, utils, config } = await loadFixture(
      deployVault.bind(null, { initial_deposit_limit: DEPOSIT_LIMIT })
    ))

    // Fund the user with underlying, and approve the vault to spend user's tokens, then perform the deposit
    await utils.mintAndApprove(DEPOSIT_LIMIT, users[0])
    await utils.mintAndApprove(DEPOSIT_LIMIT, users[1])
    await firelight_vault.connect(users[0]).deposit(DEPOSIT_AMOUNT, users[0].address)
  })
  
  it('reverts if the caller has not RESCUER_ROLE granted', async () => {
    const rescueAttempt = firelight_vault.connect(blocklister).rescueSharesFromBlocklisted(users[0].address, users[2].address)
    await expect(rescueAttempt).to.be.revertedWithCustomError(firelight_vault, 'AccessControlUnauthorizedAccount')
  })

  it('reverts if rescuer tries to rescue shares from a NOT blocklisted user', async () => {
    const rescueAttempt = firelight_vault.connect(rescuer).rescueSharesFromBlocklisted(users[0].address, users[2].address)
    await expect(rescueAttempt).to.be.revertedWithCustomError(firelight_vault, 'NotBlocklistedAddress')
  })

  it('blocklister successfully adds users to the blocklist', async () => {
    await firelight_vault.connect(blocklister).addToBlocklist(users[0].address)
    expect(await firelight_vault.isBlocklisted(users[0].address)).to.eq(true)

    await firelight_vault.connect(blocklister).addToBlocklist(users[1].address)
    expect(await firelight_vault.isBlocklisted(users[0].address)).to.eq(true)
  })

  it('reverts if rescuer tries to rescue shares to a blocklisted user', async () => {
    const rescueAttempt = firelight_vault.connect(rescuer).rescueSharesFromBlocklisted(users[0].address, users[0].address)
    await expect(rescueAttempt).to.be.revertedWithCustomError(firelight_vault, 'BlocklistedAddress')
  })

  it('reverts if rescuer tries to rescue shares to a zero address', async () => {
    const rescueAttempt = firelight_vault.connect(rescuer).rescueSharesFromBlocklisted(users[0].address, ethers.ZeroAddress)
    await expect(rescueAttempt).to.be.revertedWithCustomError(firelight_vault, 'ERC20InvalidReceiver')
  })

  it('reverts if rescuer tries to rescue shares from blocklisted user with no shares', async () => {
    const rescueAttempt = firelight_vault.connect(rescuer).rescueSharesFromBlocklisted(users[1].address, users[2].address)
    await expect(rescueAttempt).to.be.revertedWithCustomError(firelight_vault, 'InsufficientShares')
  })

  it('rescuer transfers shares from blocklisted user', async () => {
    const prevTs = await time.latest()
    expect(await firelight_vault.balanceOf(users[0].address)).to.eq(DEPOSIT_AMOUNT)
    
    const rescueTrx = firelight_vault.connect(rescuer).rescueSharesFromBlocklisted(users[0].address, users[2].address)
    await expect(rescueTrx).to.emit(firelight_vault, 'SharesRescuedFromBlocklisted').withArgs(
      users[0].address, users[2].address, DEPOSIT_AMOUNT
    )
    
    expect(await firelight_vault.balanceOf(users[0].address)).to.eq(0)
    expect(await firelight_vault.balanceOf(users[2].address)).to.eq(DEPOSIT_AMOUNT)

    // Verify checkpoints
    const nowTs = await time.latest()
    expect(await firelight_vault.balanceOfAt(users[0].address, nowTs)).to.eq(0)
    expect(await firelight_vault.balanceOfAt(users[0].address, prevTs)).to.eq(DEPOSIT_AMOUNT)
    expect(await firelight_vault.balanceOfAt(users[2].address, nowTs)).to.eq(DEPOSIT_AMOUNT)
    expect(await firelight_vault.balanceOfAt(users[2].address, prevTs)).to.eq(0)
  })

  it('reverts if rescuer tries to rescue shares from blocklisted user again', async () => {
    const rescueAttempt = firelight_vault.connect(rescuer).rescueSharesFromBlocklisted(users[0].address, users[2].address)
    await expect(rescueAttempt).to.be.revertedWithCustomError(firelight_vault, 'InsufficientShares')
  })

  it('a user successfully requests a withdraw', async () => {
    const currentPeriod = await firelight_vault.currentPeriod()
    const withdrawTrx = firelight_vault.connect(users[2]).withdraw(PART_WITHDRAW_AMOUNT, users[2].address, users[2].address)
    await expect(withdrawTrx).to.emit(firelight_vault, 'WithdrawRequest').withArgs(
      users[2].address, users[2].address, users[2].address, currentPeriod + 1n, PART_WITHDRAW_AMOUNT, PART_WITHDRAW_AMOUNT
    )
  })

  it('move forward one period and a user successfully requests a second withdraw, and move forward another period', async () => {
    await time.increase(config.period_configuration_duration)
    const withdrawTrx = firelight_vault.connect(users[2]).withdraw(PART_WITHDRAW_AMOUNT, users[2].address, users[2].address)
    await expect(withdrawTrx).to.emit(firelight_vault, 'WithdrawRequest')
    await time.increase(config.period_configuration_duration)
  })

  it('reverts if the caller has not RESCUER_ROLE granted', async () => {
    const rescueAttempt = firelight_vault.connect(blocklister).rescueWithdrawFromBlocklisted(users[2].address, rescuer.address, [1,2])
    await expect(rescueAttempt).to.be.revertedWithCustomError(firelight_vault, 'AccessControlUnauthorizedAccount')
  })

  it('reverts if rescuer tries to rescue pending withdrawals from a blocklisted user to another blocklisted user', async () => {
    const rescueAttempt = firelight_vault.connect(rescuer).rescueWithdrawFromBlocklisted(users[1].address, users[1].address, [1,2])
    await expect(rescueAttempt).to.revertedWithCustomError(firelight_vault,'BlocklistedAddress')
  })

  it('reverts if rescuer tries to rescue pending withdrawals from a blocklisted user to zero address', async () => {
    const rescueAttempt = firelight_vault.connect(rescuer).rescueWithdrawFromBlocklisted(users[1].address, ethers.ZeroAddress, [1,2])
    await expect(rescueAttempt).to.revertedWithCustomError(firelight_vault,'InvalidAddress')
  })

  it('user successfully requests a third withdraw, claims the first one, and move forward one period', async () => {
    // Claims first request
    const prevBal = await token_contract.balanceOf(users[2].address)
    const claimTrx = firelight_vault.connect(users[2]).claimWithdraw(1)
    await expect(claimTrx).to.emit(firelight_vault, 'CompleteWithdraw').withArgs(users[2].address, PART_WITHDRAW_AMOUNT, 1)
    expect(await token_contract.balanceOf(users[2].address)).to.eq(prevBal + PART_WITHDRAW_AMOUNT)

    // Creates new request
    const currentPeriod = await firelight_vault.currentPeriod()
    const withdrawTrx = firelight_vault.connect(users[2]).withdraw(PART_WITHDRAW_AMOUNT, users[2].address, users[2].address)
    await expect(withdrawTrx).to.emit(firelight_vault, 'WithdrawRequest').withArgs(
      users[2].address, users[2].address, users[2].address, currentPeriod + 1n, PART_WITHDRAW_AMOUNT, PART_WITHDRAW_AMOUNT
    )

    await time.increase(config.period_configuration_duration)
  })

  it('reverts if rescuer tries to rescue pending withdrawals from a NOT blocklisted user', async () => {
    const rescueAttempt = firelight_vault.connect(rescuer).rescueWithdrawFromBlocklisted(users[2].address, rescuer.address, [1,2])
    await expect(rescueAttempt).to.revertedWithCustomError(firelight_vault,'NotBlocklistedAddress')
  })

  it('reverts if rescuer tries to rescue pending withdrawals to a user who has already claimed that period', async () => {
    const rescueAttempt = firelight_vault.connect(rescuer).rescueWithdrawFromBlocklisted(users[0].address, users[2].address, [1])
    await expect(rescueAttempt).to.revertedWithCustomError(firelight_vault,'AlreadyClaimedPeriod')
  })

  it('blocklister successfully adds a user with pending a withdraw to the blocklist', async () => {
    await firelight_vault.connect(blocklister).addToBlocklist(users[2].address)
    expect(await firelight_vault.isBlocklisted(users[2].address)).to.eq(true)
  })

  it('blocklisted user cannot claim withdraw anymore', async () => {
    await expect(firelight_vault.connect(users[2]).claimWithdraw(1)).to.be.reverted
  })

  it('reverts if rescuer tries to rescue pending withdrawals if one or more periods have no pending amount', async () => {
    const rescueAttempt = firelight_vault.connect(rescuer).rescueWithdrawFromBlocklisted(users[2].address, rescuer.address, [2,3,4])
    await expect(rescueAttempt).to.revertedWithCustomError(firelight_vault,'NoWithdrawalAmount').withArgs(4)
  })

  it('reverts if rescuer tries to rescue pending withdrawals if one or more periods were already claimed', async () => {
    const rescueAttempt = firelight_vault.connect(rescuer).rescueWithdrawFromBlocklisted(users[2].address, rescuer.address, [2,1])
    await expect(rescueAttempt).to.revertedWithCustomError(firelight_vault,'AlreadyClaimedPeriod').withArgs(1)
  })

  it('rescuer successfully rescues the two pending withdrawals from blocklisted user to itself', async () => {
    const periods = [2,3]
    const rescuedShares = [PART_WITHDRAW_AMOUNT, PART_WITHDRAW_AMOUNT]

    const rescueTrx = firelight_vault.connect(rescuer).rescueWithdrawFromBlocklisted(users[2].address, rescuer.address, periods)
    await expect(rescueTrx).to.emit(firelight_vault, 'WithdrawRescuedFromBlocklisted').withArgs(
      users[2].address, rescuer.address, periods, rescuedShares
    )
  })

  it('move forward one more period and rescuer successfully claims all recued shares', async () => {
    expect(await token_contract.balanceOf(rescuer.address)).to.eq(0)

    // Second period
    const rescue2Trx = firelight_vault.connect(rescuer).claimWithdraw(2)
    await expect(rescue2Trx).to.emit(firelight_vault, 'CompleteWithdraw').withArgs(rescuer.address, PART_WITHDRAW_AMOUNT, 2)
    expect(await token_contract.balanceOf(rescuer.address)).to.eq(PART_WITHDRAW_AMOUNT)

    // Move one perdiod to make second withdraw available
    await time.increase(config.period_configuration_duration)
    
    // Third period
    const rescue3Trx = firelight_vault.connect(rescuer).claimWithdraw(3)
    await expect(rescue3Trx).to.emit(firelight_vault, 'CompleteWithdraw').withArgs(rescuer.address, PART_WITHDRAW_AMOUNT, 3)
    expect(await token_contract.balanceOf(rescuer.address)).to.eq(PART_WITHDRAW_AMOUNT * 2n)
  })

  it('reverts if rescuer tries to claim a period already claimed', async () => {
    const claimAttempt = firelight_vault.connect(rescuer).claimWithdraw(3)
    await expect(claimAttempt).to.be.revertedWithCustomError(firelight_vault, 'AlreadyClaimedPeriod')
  })

})