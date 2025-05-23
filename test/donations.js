const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')
const { deployVault } = require('./setup/fixtures.js')
const { expect } = require('chai')

describe('Donations test', function() {
  const DECIMALS = 6,
        DEPOSIT_AMOUNT = ethers.parseUnits('5000', DECIMALS)

  let attacker

  before(async () => {
    ({ token_contract, firelight_vault, limit_updater: minter, users, utils } = await loadFixture(
      deployVault.bind()
    ))
    attacker = users[0]

    // Fund the users with underlying, and approve the vault to spend users' tokens
    await Promise.all(users.map(account => utils.mintAndApprove(DEPOSIT_AMOUNT, account)))
  })

  it('does not allow an attacker to profit by performing a donation', async () => {
    // Attacker makes a donation when the vault is empty
    await token_contract.connect(attacker).transfer(firelight_vault.target, ethers.parseUnits('10', DECIMALS))

    // A user makes a deposit equal or less than donation
    await firelight_vault.connect(users[1]).deposit(ethers.parseUnits('10', DECIMALS), users[1].address)

    expect(await firelight_vault.balanceOf(attacker.address)).to.be.eq(0)
    expect(await firelight_vault.maxWithdraw(attacker.address)).to.be.eq(0)
    expect(await firelight_vault.maxRedeem(attacker.address)).to.be.eq(0)

    const withdraw_request = firelight_vault.connect(attacker).withdraw(1, attacker.address, attacker.address)

    await expect(withdraw_request).to.be.revertedWithCustomError(firelight_vault, 'InsufficientShares')
  })

  it('should allow the depositor to withdraw', async () => {
    // NOTE: This problem will be mitigated by making a deposit to the vault during deployment
 
    // The depositor lost its tokens
    expect(await firelight_vault.balanceOf(users[1].address)).to.be.eq(0)
    expect(await firelight_vault.maxWithdraw(users[1].address)).to.be.eq(0)
    expect(await firelight_vault.maxRedeem(users[1].address)).to.be.eq(0)

    // The depositor cannot withdraw 1 wei
    const withdraw_request = firelight_vault.connect(users[1]).withdraw(1, users[1].address, users[1].address)
    expect(withdraw_request).to.be.revertedWithCustomError(firelight_vault, 'InsufficientShares')
  })
})