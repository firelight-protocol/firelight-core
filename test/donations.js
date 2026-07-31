const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')
const { deployVault } = require('./setup/fixtures.js')
const { expect } = require('chai')

describe('Donations test', function() {
  const DECIMALS = 6,
        DEPOSIT_AMOUNT = ethers.parseUnits('5000', DECIMALS),
        DONATION = ethers.parseUnits('10', DECIMALS)

  let attacker

  before(async () => {
    ({ token_contract, firelight_vault, limit_updater: minter, users, utils } = await loadFixture(
      deployVault.bind()
    ))
    attacker = users[0]

    // Fund the users with underlying, and approve the vault to spend users' tokens.
    // Sequential (not Promise.all): each mintAndApprove impersonates the same
    // asset_manager; concurrent impersonation/stop calls race and surface as
    // "Unknown account" inside hardhat.
    for (const account of users) await utils.mintAndApprove(DEPOSIT_AMOUNT, account)
  })

  it('does not allow an attacker to profit by performing a donation', async () => {
    // Attacker makes a donation when the vault is empty
    await token_contract.connect(attacker).transfer(firelight_vault.target, DONATION)

    // A deposit equal or less than the donation would floor to zero shares:
    // it reverts instead of pulling the depositor's assets for nothing
    const dust_deposit = firelight_vault.connect(users[1]).deposit(DONATION, users[1].address)
    await expect(dust_deposit).to.be.revertedWithCustomError(firelight_vault, 'InvalidAmount')

    // The depositor kept their tokens and the attacker gained no claim on the vault
    expect(await token_contract.balanceOf(users[1].address)).to.be.eq(DEPOSIT_AMOUNT)
    expect(await firelight_vault.balanceOf(attacker.address)).to.be.eq(0)
    expect(await firelight_vault.maxWithdraw(attacker.address)).to.be.eq(0)
    expect(await firelight_vault.maxRedeem(attacker.address)).to.be.eq(0)

    const withdraw_request = firelight_vault.connect(attacker).withdraw(1, attacker.address, attacker.address)
    await expect(withdraw_request).to.be.revertedWithCustomError(firelight_vault, 'InsufficientShares')
  })

  it('a deposit large enough to mint shares succeeds and absorbs the donation', async () => {
    await firelight_vault.connect(users[1]).deposit(DEPOSIT_AMOUNT, users[1].address)

    const shares = await firelight_vault.balanceOf(users[1].address)
    expect(shares).to.be.gt(0)
    // The donation inflates the share price, so floor rounding can cost the depositor
    // up to one share's value (≈ the donation) — but never more.
    expect(await firelight_vault.maxWithdraw(users[1].address)).to.be.gte(DEPOSIT_AMOUNT - DONATION)
  })
})
