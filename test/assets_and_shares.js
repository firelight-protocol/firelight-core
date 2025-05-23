const { impersonateAndSend, setBalance } = require('../lib/utils_test')
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')
const { deployVault } = require('./setup/fixtures.js')
const { expect } = require('chai')

describe('Assets and shares tests', function () {

  describe('Using an underlying token that has 6 decimals', function () {
    const DECIMALS = 6,
          DEPOSITS = ['100', '75', '25'].map(a => ethers.parseUnits(a, DECIMALS))

    before(async () => {
      ({ firelight_vault, token_contract, minter, burner, users, deployer, utils } = await loadFixture(
        deployVault.bind(null, { decimals: DECIMALS, initial_deposit_limit: ethers.parseUnits('100000', DECIMALS) })
      ))

      // Mint and approve 100k tokens
      const amount = ethers.parseUnits('100000', DECIMALS)
      await Promise.all([...users, minter, deployer].map(account => utils.mintAndApprove(amount, account)))
    })

    it('correctly updates the LST balance for several users deposits', async () => {
      const deposits = DEPOSITS.map((d, i) => firelight_vault.connect(users[i]).deposit(d, users[i].address))

      for (let i = 0; i < DEPOSITS.length; i++)
        await expect(deposits[i]).to.changeTokenBalances(token_contract, [users[i], firelight_vault], [ -DEPOSITS[i], DEPOSITS[i] ])
    })

    it('token amounts should be same as shares amounts with offset', async () => {
      const offset = (await firelight_vault.decimals() - await token_contract.decimals()),
            max_withdraw = await Promise.all(DEPOSITS.map((_, i) => firelight_vault.maxWithdraw(users[i].address))),
            max_redeem = await Promise.all(DEPOSITS.map((_, i) => firelight_vault.maxRedeem(users[i].address)))
      
      for (let i = 0; i < DEPOSITS.length; i++)
        expect(max_withdraw[i]).to.be.eq(max_redeem[i] / 10n**offset)
    })

    it('shares values increase after the vault receives rewards', async () => {
      const perc = 10n,
            total_assets = await firelight_vault.totalAssets(),
            donation = total_assets * perc / 100n
      await token_contract.transfer(firelight_vault.target, donation)
      expect(await firelight_vault.totalAssets()).to.be.eq(total_assets + donation)

      const max_withdraw = await Promise.all(DEPOSITS.map((_, i) => firelight_vault.maxWithdraw(users[i].address))),
            max_redeem = await Promise.all(DEPOSITS.map((_, i) => firelight_vault.maxRedeem(users[i].address))),
            rounding = 1n
            
      for (let i = 0; i < DEPOSITS.length; i++)
        expect(max_withdraw[i]).to.be.eq(max_redeem[i] * (100n + perc) / 100n - rounding)
    })

    it('balanceOfAt current timestamp should return the same value as balanceOf', async () => {
      const timestamp = (await ethers.provider.getBlock("latest")).timestamp
      expect(await firelight_vault.balanceOfAt(users[0].address, timestamp)).to.be.eq(await firelight_vault.balanceOf(users[0].address))
    })

    it('totalSupplyAt current timestamp should return the same value as totalSupply', async () => {
      const timestamp = (await ethers.provider.getBlock("latest")).timestamp
      expect(await firelight_vault.totalSupplyAt(timestamp)).to.be.eq(await firelight_vault.totalSupply())      
    })

    it('totalSupply should be 10% more then totalAssets', async () => {
      expect(await firelight_vault.totalAssets()).to.be.eq(await firelight_vault.totalSupply() * 110n / 100n)  
    })

    it('reverts when trying to call mint without MINTER_ROLE', async () => {
      await expect(firelight_vault.connect(users[0]).mint(1, minter.address))
        .to.be.revertedWithCustomError(firelight_vault, 'AccessControlUnauthorizedAccount')
    })

    it('decreases others\' maxRedeem() by 1/3 when minter mints double of total shares to itself using mint', async () => {
      const shares = (await firelight_vault.totalSupply()) * 2n

      const u1Max = await firelight_vault.maxWithdraw(users[0].address)
      const u3Max = await firelight_vault.maxWithdraw(users[2].address)
      const u2Max = await firelight_vault.maxWithdraw(users[1].address)

      await expect(firelight_vault.connect(minter).mint(shares, minter.address)).to.emit(firelight_vault, 'Transfer')

      expect(await firelight_vault.maxWithdraw(users[0].address)).to.be.eq(u1Max / 3n)
      expect(await firelight_vault.maxWithdraw(users[1].address) - 1n).to.be.eq(u2Max / 3n) // rounding
      expect(await firelight_vault.maxWithdraw(users[2].address)).to.be.eq(u3Max / 3n)
    })
 
    it('previewRedeem(balanceOf) should return the same value as maxWithdraw for all users', async () => {
      const preview_withdraw = await Promise.all(DEPOSITS.map((_, i) => firelight_vault.previewRedeem(firelight_vault.balanceOf(users[i].address) ))),
            max_redeem = await Promise.all(DEPOSITS.map((_, i) => firelight_vault.maxWithdraw(users[i].address)))
      
      for (let i = 0; i < DEPOSITS.length; i++)
        expect(preview_withdraw[i]).to.be.eq(max_redeem[i])
    })

    it('impersonates firelight_vault as signer and transfers 10 tokens to deployer', async () => {
      await setBalance(firelight_vault.target, ethers.parseEther('1'))
      
      const amount = ethers.parseUnits('10', await token_contract.decimals())

      const transfer_tx = impersonateAndSend(firelight_vault.target, {
        from: firelight_vault.target,
        to: token_contract.target,
        data: token_contract.interface.encodeFunctionData('transfer', [deployer.address, amount])
      }, false)

      await expect(transfer_tx).to.changeTokenBalances(token_contract, [firelight_vault, deployer], [-amount, amount])
    })
	})

  describe('Using an underlying token that has 0 decimals', function () {
    const DECIMALS = 0,
          DEPOSITS = ['15', '7', '3']

    before(async () => {
      ({ firelight_vault, token_contract, minter, burner, users, deployer, utils } = await loadFixture(
        deployVault.bind(null, { decimals: DECIMALS, initial_deposit_limit: ethers.parseUnits('100000', DECIMALS) })
      ))
  
      // Mint and approve 100k tokens
      const amount = ethers.parseUnits('100000', DECIMALS)
      await Promise.all([...users, minter, deployer].map(account => utils.mintAndApprove(amount, account)))
    })

    it('correctly accounts for deposits from several users', async () => {
      const deposits = DEPOSITS.map((d, i) => firelight_vault.connect(users[i]).deposit(d, users[i].address))

      for (let i = 0; i < DEPOSITS.length; i++)
        await expect(deposits[i]).to.changeTokenBalances(token_contract, [users[i], firelight_vault], [ -DEPOSITS[i], DEPOSITS[i] ])
    })

    it('returns the same value for previewRedeem(balanceOf) and maxWithdraw for all users', async () => {
      const preview_withdraw = await Promise.all(DEPOSITS.map((_, i) => firelight_vault.previewRedeem(firelight_vault.balanceOf(users[i].address)))),
      max_redeem = await Promise.all(DEPOSITS.map((_, i) => firelight_vault.maxWithdraw(users[i].address)))

      for (let i = 0; i < DEPOSITS.length; i++)
        expect(preview_withdraw[i]).to.be.eq(max_redeem[i])
    })
	})
})