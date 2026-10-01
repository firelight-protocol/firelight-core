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

    // Fund the users with underlying, and approve the vault to spend users' tokens.
    // Sequential (not Promise.all): each mintAndApprove impersonates the same
    // asset_manager; concurrent impersonation/stop calls race and surface as
    // "Unknown account" inside hardhat.
    for (const account of users) await utils.mintAndApprove(DEPOSIT_AMOUNT, account)
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

  it('returns correct values for maxDeposit and maxMint', async () => {
    const max_deposit = await firelight_vault.maxDeposit(users[0].address),
          shares_preview = await firelight_vault.previewDeposit(max_deposit),
          max_mint = await firelight_vault.maxMint(users[0].address)

    expect(max_deposit).to.be.equal(TARGET_DEPOSIT_LIMIT)
    expect(max_mint).to.be.equal(shares_preview)
  })

  it('deposits tokens and receives the expected amount of shares', async () => {
    const shares_preview = await firelight_vault.previewDeposit(DEPOSIT_AMOUNT),
          deposit_tx = firelight_vault.connect(users[0]).deposit(DEPOSIT_AMOUNT, users[0])
    
    await expect(deposit_tx).to.emit(firelight_vault, 'Deposit').withArgs(
      users[0].address, users[0].address, DEPOSIT_AMOUNT, shares_preview
    )

    const shares = await firelight_vault.balanceOf(users[0].address)
    expect(shares.toString()).to.equal(DEPOSIT_AMOUNT)

    const max_deposit = await firelight_vault.maxDeposit(users[0].address),
          max_deposit_shares = await firelight_vault.previewDeposit(max_deposit),
          max_mint = await firelight_vault.maxMint(users[0].address)

    expect(max_deposit).to.be.equal(TARGET_DEPOSIT_LIMIT - DEPOSIT_AMOUNT)
    expect(max_mint).to.be.equal(max_deposit_shares)
  })

  it('mints shares and deducts the expected amount of tokens', async () => {
    const prev_token_bal = await token_contract.balanceOf(users[1]),
          assets_preview = await firelight_vault.previewMint(DEPOSIT_AMOUNT),
          mint_tx = firelight_vault.connect(users[1]).mint(DEPOSIT_AMOUNT, users[1])
   
    await expect(mint_tx).to.emit(firelight_vault, 'Deposit').withArgs(
      users[1].address, users[1].address, assets_preview, DEPOSIT_AMOUNT
    )

    const shares = await firelight_vault.balanceOf(users[1].address)
    expect(shares.toString()).to.equal(DEPOSIT_AMOUNT)

    const assets = await token_contract.balanceOf(users[1].address)
    expect(assets).to.equal(prev_token_bal - DEPOSIT_AMOUNT)

    const max_deposit = await firelight_vault.maxDeposit(users[0].address),
          max_deposit_shares = await firelight_vault.previewDeposit(max_deposit),
          max_mint = await firelight_vault.maxMint(users[0].address)

    expect(max_deposit).to.be.equal(TARGET_DEPOSIT_LIMIT - DEPOSIT_AMOUNT * 2n)
    expect(max_mint).to.be.equal(max_deposit_shares)
  })

  it('reverts when user tries to request withdraw with more than what it owns', async () => {
    const withdraw_request = firelight_vault.connect(users[0]).withdraw(DEPOSIT_AMOUNT + 1n, users[0].address, users[0].address)
    await expect(withdraw_request).to.be.revertedWithCustomError(firelight_vault, 'InsufficientShares')
  })

  it('reverts when user tries to request redeem with more than what it owns', async () => {
    const withdraw_request = firelight_vault.connect(users[1]).redeem(DEPOSIT_AMOUNT + 1n, users[1].address, users[1].address)
    await expect(withdraw_request).to.be.revertedWithCustomError(firelight_vault, 'InsufficientShares')
  })

  it('returns correct values for maxWithdraw and maxRedeem', async () => {
    const max_withdraw = await firelight_vault.connect(users[0]).maxWithdraw(users[0].address),
          max_withdraw_shares = await firelight_vault.connect(users[0]).previewWithdraw(max_withdraw),
          max_redeem = await firelight_vault.connect(users[0]).maxRedeem(users[0].address)

    expect(max_withdraw).to.be.equal(DEPOSIT_AMOUNT)
    expect(max_redeem).to.be.equal(max_withdraw_shares)
  })

  it('reverts when trying to complete the withdraw before the next period', async() => {
    const receipt = await (await firelight_vault.connect(users[0]).withdraw(DEPOSIT_AMOUNT, users[0].address, users[0].address)).wait()
    withdraw_period = receipt.logs[1].args[3]

    const withdraw_attempt = firelight_vault.connect(users[0]).claimWithdraw(withdraw_period)
    await expect(withdraw_attempt).to.be.revertedWithCustomError(firelight_vault, 'InvalidPeriod')

    const max_withdraw = await firelight_vault.connect(users[0]).maxWithdraw(users[0].address),
          max_redeem = await firelight_vault.connect(users[0]).maxRedeem(users[0].address)

    expect(max_withdraw).to.be.equal(0n)
    expect(max_redeem).to.be.equal(0n)
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

  it('decreases the deposit limit below total value', async () => {
    await firelight_vault.connect(limit_updater).updateDepositLimit(INITIAL_DEPOSIT_LIMIT)

    const deposit_limit = await firelight_vault.depositLimit()
    expect(deposit_limit.toString()).to.equal(INITIAL_DEPOSIT_LIMIT)

    const max_deposit = await firelight_vault.maxDeposit(users[0].address),
          max_mint = await firelight_vault.maxMint(users[0].address)

    expect(max_deposit).to.be.equal(0n)
    expect(max_mint).to.be.equal(0n)
  })
})
describe('Zero-share deposit guard', function() {
  const DECIMALS = 6
  const DEPOSIT = ethers.parseUnits('100', DECIMALS)
  const DONATION = ethers.parseUnits('50', DECIMALS)

  const inflatedPriceFixture = async () => {
    const ctx = await deployVault()
    await ctx.utils.mintAndApprove(DEPOSIT, ctx.users[0])
    await ctx.firelight_vault.connect(ctx.users[0]).deposit(DEPOSIT, ctx.users[0].address)
    // Donate assets directly so the share price rises above 1:1
    await ctx.token_contract.mintTo(ctx.firelight_vault.target, DONATION)
    await ctx.utils.mintAndApprove(ethers.parseUnits('1', DECIMALS), ctx.users[1])
    return ctx
  }

  it('reverts a dust deposit that would floor to zero shares', async () => {
    const { firelight_vault, users } = await loadFixture(inflatedPriceFixture)

    expect(await firelight_vault.previewDeposit(1n)).to.equal(0n)
    await expect(firelight_vault.connect(users[1]).deposit(1n, users[1].address))
      .to.be.revertedWithCustomError(firelight_vault, 'InvalidAmount')
  })

  it('still accepts the smallest deposit that mints at least one share', async () => {
    const { firelight_vault, users } = await loadFixture(inflatedPriceFixture)

    const twoShareDeposit = 2n // 2 wei at share price 1.5 → 1 share
    expect(await firelight_vault.previewDeposit(twoShareDeposit)).to.equal(1n)
    await expect(firelight_vault.connect(users[1]).deposit(twoShareDeposit, users[1].address))
      .to.emit(firelight_vault, 'Deposit')
    expect(await firelight_vault.balanceOf(users[1].address)).to.equal(1n)
  })
})

describe('Zero-asset redeem guard', function() {
  // Brings the vault to a share price below 1 (the normal post-payout state): a 100-asset
  // deposit is slashed to 1 asset against 100 shares, so a small redeem floors to zero assets.
  async function slashedPriceFixture() {
    const ctx = await loadFixture(deployVault.bind(null, { decimals: 0n, initial_deposit_limit: 1000n }))
    const user = ctx.users[0]

    await ctx.utils.mintAndApprove(100n, user)
    await ctx.firelight_vault.connect(user).deposit(100n, user.address)

    await time.increase(ctx.config.period_configuration_duration)
    const captureTimestamp = await ctx.firelight_vault.currentPeriodStart()
    await ctx.firelight_vault.connect(ctx.payout_signer).payout(ctx.payout_receiver.address, 99n, captureTimestamp)

    return ctx
  }

  it('reverts a dust redeem that would floor to zero assets, leaving the shares untouched', async () => {
    const { firelight_vault, users } = await slashedPriceFixture()
    const user = users[0]

    expect(await firelight_vault.totalAssets()).to.equal(1n)
    expect(await firelight_vault.totalSupply()).to.equal(100n)
    expect(await firelight_vault.convertToAssets(1n)).to.equal(0n)

    const sharesBefore = await firelight_vault.balanceOf(user.address)
    const supplyBefore = await firelight_vault.totalSupply()

    await expect(firelight_vault.connect(user).redeem(1n, user.address, user.address))
      .to.be.revertedWithCustomError(firelight_vault, 'InvalidAmount')

    // The shares must survive the reverted redeem.
    expect(await firelight_vault.balanceOf(user.address)).to.equal(sharesBefore)
    expect(await firelight_vault.totalSupply()).to.equal(supplyBefore)
  })

  it('still accepts the smallest redeem that returns at least one asset', async () => {
    const { firelight_vault, users } = await slashedPriceFixture()
    const user = users[0]

    // At price 1/100: convertToAssets(50) floors to 0, 51 is the first to yield 1 asset.
    expect(await firelight_vault.convertToAssets(50n)).to.equal(0n)
    expect(await firelight_vault.convertToAssets(51n)).to.equal(1n)

    expect(await firelight_vault.connect(user).redeem.staticCall(51n, user.address, user.address)).to.equal(1n)
    await expect(firelight_vault.connect(user).redeem(51n, user.address, user.address))
      .to.emit(firelight_vault, 'WithdrawRequest')
    expect(await firelight_vault.balanceOf(user.address)).to.equal(49n)
  })

  it('reports zero from maxRedeem when the whole balance floors to zero assets', async () => {
    const { firelight_vault, users } = await slashedPriceFixture()
    const [owner, dust] = users

    // Move the balance below the point where it converts to a single asset, so that no amount of
    // this holder's shares is redeemable.
    await firelight_vault.connect(owner).transfer(dust.address, 50n)
    expect(await firelight_vault.convertToAssets(50n)).to.equal(0n)

    expect(await firelight_vault.maxRedeem(dust.address)).to.equal(0n)
    await expect(firelight_vault.connect(dust).redeem(50n, dust.address, dust.address))
      .to.be.revertedWithCustomError(firelight_vault, 'InvalidAmount')
  })

  it('keeps advertising the full balance from maxRedeem while it is redeemable', async () => {
    const { firelight_vault, users } = await slashedPriceFixture()
    const user = users[0]

    // The whole balance still yields an asset, so maxRedeem must not shrink, and redeeming exactly
    // the advertised amount must not revert.
    const shares = await firelight_vault.balanceOf(user.address)
    expect(await firelight_vault.convertToAssets(shares)).to.equal(1n)
    expect(await firelight_vault.maxRedeem(user.address)).to.equal(shares)

    await expect(firelight_vault.connect(user).redeem(shares, user.address, user.address))
      .to.emit(firelight_vault, 'WithdrawRequest')
  })
})

describe('ERC-4626 maximum deposit limits', function() {
  it('allows minting the positive amount returned by maxMint after the share price increases', async () => {
    const ctx = await loadFixture(deployVault.bind(null, { initial_deposit_limit: 6n }))
    const user = ctx.users[0]

    await ctx.utils.mintAndApprove(7n, user)
    await ctx.firelight_vault.connect(user).deposit(1n, user.address)
    // A direct transfer models rewards entering the vault without minting shares.
    await ctx.token_contract.connect(user).transfer(ctx.firelight_vault.target, 1n)

    const maxMint = await ctx.firelight_vault.maxMint(user.address)

    await expect(ctx.firelight_vault.connect(user).mint(maxMint, user.address)).not.to.be.reverted
    expect(maxMint).to.equal(2n)
  })

  it('allows depositing the amount returned by maxDeposit when it is positive', async () => {
    const ctx = await loadFixture(deployVault.bind(null, { initial_deposit_limit: 2n }))
    const user = ctx.users[0]

    await ctx.utils.mintAndApprove(2n, user)
    // This leaves one asset of headroom, which is too little to mint a share.
    await ctx.token_contract.connect(user).transfer(ctx.firelight_vault.target, 1n)

    const maxDeposit = await ctx.firelight_vault.maxDeposit(user.address)

    if (maxDeposit > 0n) {
      await expect(ctx.firelight_vault.connect(user).deposit(maxDeposit, user.address)).not.to.be.reverted
    }
    expect(maxDeposit).to.equal(0n)
  })
})
