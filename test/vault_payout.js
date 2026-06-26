const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployVault } = require("./setup/fixtures.js");
const { expect } = require("chai");

async function setupVaultPayout(amount) {
  const ctx = await loadFixture(
    deployVault.bind(null, {
      decimals: 0n,
      initial_deposit_limit: 20n,
    }),
  );

  const user = ctx.users[0];
  await ctx.utils.mintAndApprove(amount, user);
  await ctx.firelight_vault.connect(user).deposit(amount, user.address);

  return ctx;
}

describe("FirelightVault payout accounting", function () {
  it("does not assign rounding residual to an empty next withdrawal bucket", async () => {
    const { token_contract, firelight_vault, payout_signer, payout_receiver, users, config } =
      await setupVaultPayout(2n);

    expect(await firelight_vault.totalAssets()).to.equal(2n);
    expect(await token_contract.balanceOf(firelight_vault.target)).to.equal(2n);

    await time.increase(config.period_configuration_duration);

    const captureTimestamp = await firelight_vault.currentPeriodStart();
    const capturePeriod = await firelight_vault.currentPeriod();

    await firelight_vault.connect(users[0]).withdraw(1n, users[0].address, users[0].address);

    expect(await token_contract.balanceOf(firelight_vault.target)).to.equal(2n); // still 2
    expect(await firelight_vault.totalAssets()).to.equal(1n);
    expect(await firelight_vault.withdrawAssets(capturePeriod + 1n)).to.equal(1n);
    expect(await firelight_vault.pendingWithdrawAssets()).to.equal(1n);

    await expect(firelight_vault.connect(payout_signer).payout(payout_receiver.address, 1n, captureTimestamp))
      .to.emit(firelight_vault, "PayoutExecuted")
      .withArgs(payout_receiver.address, 1n, 1n, captureTimestamp);

    expect(await firelight_vault.totalAssets()).to.equal(1n);
    expect(await firelight_vault.withdrawAssets(capturePeriod + 1n)).to.equal(0n);
    expect(await firelight_vault.withdrawAssets(capturePeriod + 2n)).to.equal(0n);
    expect(await firelight_vault.pendingWithdrawAssets()).to.equal(0n);

    expect(await token_contract.balanceOf(payout_receiver.address)).to.equal(1n);
    expect(await token_contract.balanceOf(firelight_vault.target)).to.equal(1n);
  });

  it("caps payout to available assets while reducing both withdrawal buckets in the following period", async () => {
    const { token_contract, firelight_vault, payout_signer, payout_receiver, users, config } =
      await setupVaultPayout(2n);

    await time.increase(config.period_configuration_duration);

    const captureTimestamp = await firelight_vault.currentPeriodStart();
    const capturePeriod = await firelight_vault.currentPeriod();

    await firelight_vault.connect(users[0]).withdraw(1n, users[0].address, users[0].address);

    await time.increase(config.period_configuration_duration);

    await firelight_vault.connect(users[0]).withdraw(1n, users[0].address, users[0].address);

    expect(await firelight_vault.withdrawAssets(capturePeriod + 1n)).to.equal(1n);
    expect(await firelight_vault.withdrawAssets(capturePeriod + 2n)).to.equal(1n);
    expect(await firelight_vault.pendingWithdrawAssets()).to.equal(2n);

    await expect(firelight_vault.connect(payout_signer).payout(payout_receiver.address, 3n, captureTimestamp))
      .to.emit(firelight_vault, "PayoutExecuted")
      .withArgs(payout_receiver.address, 3n, 2n, captureTimestamp);

    expect(await firelight_vault.totalAssets()).to.equal(0n);
    expect(await firelight_vault.withdrawAssets(capturePeriod + 1n)).to.equal(0n);
    expect(await firelight_vault.withdrawAssets(capturePeriod + 2n)).to.equal(0n);
    expect(await firelight_vault.pendingWithdrawAssets()).to.equal(0n);

    expect(await token_contract.balanceOf(payout_receiver.address)).to.equal(2n);
    expect(await token_contract.balanceOf(firelight_vault.target)).to.equal(0n);
  });

  it("caps payout to assets at the capture period start", async () => {
    const { token_contract, firelight_vault, payout_signer, payout_receiver, users, utils, config } =
      await setupVaultPayout(2n);

    await time.increase(config.period_configuration_duration);

    const captureTimestamp = await firelight_vault.currentPeriodStart();

    await utils.mintAndApprove(5n, users[0]);
    await firelight_vault.connect(users[0]).deposit(5n, users[0].address);

    expect(await firelight_vault.totalAssets()).to.equal(7n);
    expect(await token_contract.balanceOf(firelight_vault.target)).to.equal(7n);

    await expect(firelight_vault.connect(payout_signer).payout(payout_receiver.address, 7n, captureTimestamp))
      .to.emit(firelight_vault, "PayoutExecuted")
      .withArgs(payout_receiver.address, 7n, 2n, captureTimestamp);

    expect(await firelight_vault.totalAssets()).to.equal(5n);
    expect(await firelight_vault.pendingWithdrawAssets()).to.equal(0n);

    expect(await token_contract.balanceOf(payout_receiver.address)).to.equal(2n);
    expect(await token_contract.balanceOf(firelight_vault.target)).to.equal(5n);
  });

  it("reverts when payout is executed after the payout window expires", async () => {
    const { firelight_vault, payout_signer, payout_receiver, config } = await setupVaultPayout(2n);

    await time.increase(config.period_configuration_duration);

    const captureTimestamp = await firelight_vault.currentPeriodStart();

    await time.increase(config.period_configuration_duration * 2);

    await expect(
      firelight_vault.connect(payout_signer).payout(payout_receiver.address, 1n, captureTimestamp),
    ).to.be.revertedWithCustomError(firelight_vault, "InvalidCapturePeriod");
  });
});
