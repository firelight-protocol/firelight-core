const { loadFixture, time } = require('@nomicfoundation/hardhat-network-helpers')
const { deployVault } = require('./setup/fixtures.js')
const { expect } = require('chai');
const { ethers } = require('hardhat');

describe('Mint, burn, logs and allowance', function () {
  
    const DECIMALS = 6,
          DEPOSITS = ['50', '75', '25'].map(a => ethers.parseUnits(a, DECIMALS)),
          DEPOSITS_SUM = DEPOSITS[0] + DEPOSITS[1] + DEPOSITS[2]

    before(async () => {
      ({ firelight_vault, token_contract, minter, burner, users, deployer, utils, config } = await loadFixture(
        deployVault.bind(null, { decimals: DECIMALS, initial_deposit_limit: ethers.parseUnits('100000', DECIMALS) })
      ))

      // Mint and approve 100k tokens
      const amount = ethers.parseUnits('100000', DECIMALS)
      await Promise.all([...users, minter, deployer].map(account => utils.mintAndApprove(amount, account)))
    })

    it('users deposit into the vault', async () => {
      const deposits = DEPOSITS.map((d, i) => firelight_vault.connect(users[i]).deposit(d, users[i].address))

      for (let i = 0; i < DEPOSITS.length; i++)
        await expect(deposits[i]).to.changeTokenBalances(token_contract, [users[i], firelight_vault], [ -DEPOSITS[i], DEPOSITS[i] ])
    })
   
    it('move forward one period and should revert if trying to call burn without BURNER_ROLE', async () => {
      await time.increase(config.period_configuration_duration)
      const burn_attempt = firelight_vault.connect(users[0]).burn(1, minter.address)
      await expect(burn_attempt).to.be.revertedWithCustomError(firelight_vault, 'AccessControlUnauthorizedAccount')
    })

    it('burn all shares from user[0] if caller has BURNER_RULE. Other user\' shares value increase accordingly', async () => {
      const sharesU0 = await firelight_vault.maxRedeem(users[0].address)
      const assetsU1 = await firelight_vault.maxWithdraw(users[1].address)
      const assetsU2 = await firelight_vault.maxWithdraw(users[2].address)
      const totalSupply = await firelight_vault.totalSupply()
       
      const burn_recipt = firelight_vault.connect(burner).burn(sharesU0, users[0].address)
      
      await expect(burn_recipt).to.emit(firelight_vault, 'Transfer')
      expect(await firelight_vault.balanceOf(users[0].address)).to.be.eq(0)
      expect(await firelight_vault.maxWithdraw(users[0].address)).to.be.eq(0)
      expect(await firelight_vault.totalSupply()).to.be.eq(totalSupply - sharesU0)

      // shares' price increased in proporcion to the burned shares
      const newSharePrice = Number( await firelight_vault.totalAssets()) / Number(await firelight_vault.totalSupply()) 
      expect(await firelight_vault.maxWithdraw(users[1].address)).to.be.eq(Number(assetsU1) * newSharePrice - 1) //rounding      
      expect(await firelight_vault.maxWithdraw(users[2].address)).to.be.eq(Number(assetsU2) * newSharePrice - 1) //rounding      
    })

    it('check shares history', async () => {
      const now = await time.latest()

      //totalSypply
      expect(await firelight_vault.totalSupplyAt(now - config.period_configuration_duration)).to.be.eq(DEPOSITS_SUM) // 150
      expect(await firelight_vault.totalSupplyAt(now)).to.be.eq(DEPOSITS_SUM - DEPOSITS[0]) // 100

      // user[0]
      expect(await firelight_vault.balanceOfAt(users[0].address, now - config.period_configuration_duration)).to.be.eq(DEPOSITS[0]) // 50
      expect(await firelight_vault.balanceOfAt(users[0].address, now)).to.be.eq(0) // 0

      //totalShould not have changed
      expect(await firelight_vault.totalAssetsAt(now - config.period_configuration_duration)).to.be.eq(DEPOSITS_SUM) // 150
      expect(await firelight_vault.totalAssetsAt(now)).to.be.eq(DEPOSITS_SUM) // 150
    })

    it('move forward 10 minutes and mint shares to user[0] if caller has MINTER_ROLE', async () => {
      await time.increase(60 * 10)
      const mint_receipt = await firelight_vault.connect(minter).mint(DEPOSITS[0], users[0].address)
      await expect(mint_receipt).to.emit(firelight_vault, "Transfer").withArgs(ethers.ZeroAddress, users[0].address, DEPOSITS[0])
    })

    it('check shares history', async () => {
      const now = await time.latest()
      const tenMin = 60 * 10

      //totalSypply
      expect(await firelight_vault.totalSupplyAt(now - (config.period_configuration_duration + tenMin))).to.be.eq(DEPOSITS_SUM) // 150
      expect(await firelight_vault.totalSupplyAt(now - (tenMin))).to.be.eq(DEPOSITS_SUM - DEPOSITS[0]) // 100
      expect(await firelight_vault.totalSupplyAt(now)).to.be.eq(DEPOSITS_SUM) // 150

      // user[0]
      expect(await firelight_vault.balanceOfAt(users[0].address, now - (config.period_configuration_duration + tenMin ))).to.be.eq(DEPOSITS[0]) // 50
      expect(await firelight_vault.balanceOfAt(users[0].address, now - (tenMin))).to.be.eq(0) // 0
      expect(await firelight_vault.balanceOfAt(users[0].address, now)).to.be.eq(DEPOSITS[0]) // 50
    })

    it('user[0] gives share allowance of its deposit to user[1]', async () => {
      await (await firelight_vault.connect(users[0]).approve(users[1].address, DEPOSITS[0])).wait()
      expect(await firelight_vault.allowance(users[0].address, users[1].address)).to.be.eq(DEPOSITS[0])
    })

    it('move forward 1 day and user[1] redeems 1/2 of user[0]\'s shares with users[2] as benefiaciary', async () => {
      await time.increase(60 * 60 * 24)

      const sharesHalf = (await firelight_vault.balanceOf(users[0].address)) / 2n
      const prevBal = await firelight_vault.balanceOf(users[1].address)

      await (await firelight_vault.connect(users[1]).redeem(sharesHalf, users[2].address, users[0].address)).wait()

      // users[1]'s balanace should not change
      expect(await firelight_vault.balanceOf(users[1].address)).to.be.eq(prevBal)
      // users[0]'s balanace should decrease by halft
      expect(await firelight_vault.balanceOf(users[0].address)).to.be.eq(sharesHalf)
    })

    it('allowance should be spent', async () => {
      expect(await firelight_vault.allowance(users[0].address, users[1].address)).to.be.eq(DEPOSITS[0] / 2n)
    })

    it('totalAssets() should not count pending withdrawals', async () => {
      expect(await firelight_vault.totalAssets()).to.be.eq(DEPOSITS_SUM - DEPOSITS[0] / 2n)
    })

    it('firelight_vault should still own all original assets', async () => {
      expect(await token_contract.balanceOf(firelight_vault.target)).to.be.eq(DEPOSITS_SUM)
    })

    it('move forward two periods and user[2] claims tokens redeemed by user[1]', async () => {
      await time.increase(config.period_configuration_duration * 2)

      await expect(firelight_vault.connect(users[2]).claimWithdraw((await firelight_vault.currentPeriod()) - 1n))
        .to.changeTokenBalances(token_contract, [firelight_vault, users[2]], [- DEPOSITS[0]/2n, DEPOSITS[0]/2n])
    })

    it('firelight_vault should not own claimed tokens anymore', async () => {
      expect(await token_contract.balanceOf(firelight_vault.target)).to.be.eq(DEPOSITS_SUM - DEPOSITS[0] / 2n)
    })

    it('check history', async () => {
      const now = await time.latest()
      const beforeTwoPeriods = now - (config.period_configuration_duration * 2 + 10)

      // totalSupply
      expect(await firelight_vault.totalSupplyAt(beforeTwoPeriods)).to.be.eq(DEPOSITS_SUM)
      expect(await firelight_vault.totalSupplyAt(now)).to.be.eq(DEPOSITS_SUM - DEPOSITS[0]/2n)

      // totalAssets
      expect(await firelight_vault.totalAssetsAt(beforeTwoPeriods)).to.be.eq(DEPOSITS_SUM)
      expect(await firelight_vault.totalAssetsAt(now)).to.be.eq(DEPOSITS_SUM - DEPOSITS[0]/2n)
      
      // balanceAt of users[2] should not have changed, since the last redeem was on behaf of user[0]
      expect(await firelight_vault.balanceOfAt(users[2],beforeTwoPeriods)).to.be.eq(DEPOSITS[0]/2n)
      expect(await firelight_vault.balanceOfAt(users[2],now)).to.be.eq(DEPOSITS[0]/2n)

      // balanceAt of users[0] 
      expect(await firelight_vault.balanceOfAt(users[0],beforeTwoPeriods)).to.be.eq(DEPOSITS[0])
      expect(await firelight_vault.balanceOfAt(users[0],now)).to.be.eq(DEPOSITS[0]/2n)
    })
})