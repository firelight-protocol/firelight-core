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

  // Regression: cluster-E boundary bug (reports 88287 / 88473 / 88534 / 88555).
  // A withdrawal mined in the exact first second of a period writes a checkpoint at that
  // period's start timestamp. Because `totalAssetsAt` is inclusive (`key <= T`), that write
  // rewrites the period-start snapshot itself. Before the fix, `payout` read that mutated
  // snapshot as its exposure cap and short-paid a valid claim even though the money was still
  // in the vault (sitting in the withdrawal bucket). The fix reads `capturePeriodStart - 1`,
  // strictly before the boundary second, so the boundary withdrawal cannot lower the cap.
  it("does not let a withdrawal mined at the exact period start lower the payout cap", async () => {
    const { token_contract, firelight_vault, payout_signer, payout_receiver, users } =
      await setupVaultPayout(10n);

    // Start of the next period (the boundary second). Advancing is not needed to read it.
    const periodStart = await firelight_vault.currentPeriodEnd();

    // The opening exposure, read strictly before the boundary, is the full 10.
    expect(await firelight_vault.totalAssetsAt(periodStart - 1n)).to.equal(10n);

    // Land the withdrawal in the exact first second of the new period.
    await time.setNextBlockTimestamp(periodStart);
    await firelight_vault.connect(users[0]).withdraw(8n, users[0].address, users[0].address);

    const capturePeriod = await firelight_vault.currentPeriod();
    expect(capturePeriod).to.equal(1n);
    expect(await firelight_vault.currentPeriodStart()).to.equal(periodStart);

    // The boundary write corrupts the period-start snapshot: totalAssetsAt(periodStart) now
    // reflects the post-withdrawal net (2), while the pre-boundary value is intact (10).
    expect(await firelight_vault.totalAssetsAt(periodStart)).to.equal(2n);
    expect(await firelight_vault.totalAssetsAt(periodStart - 1n)).to.equal(10n);

    // The 8 never left: the tokens are still in the vault, held in the slashable bucket.
    expect(await token_contract.balanceOf(firelight_vault.target)).to.equal(10n);
    expect(await firelight_vault.totalAssets()).to.equal(2n);
    expect(await firelight_vault.withdrawAssets(capturePeriod + 1n)).to.equal(8n);
    expect(await firelight_vault.pendingWithdrawAssets()).to.equal(8n);

    // A valid 10-unit claim on this period. The cap now reads totalAssetsAt(periodStart - 1) = 10,
    // and activePayableAmount = totalAssets(2) + withdrawAssets[P+1](8) = 10, so it pays in FULL.
    // Under the pre-fix code the cap would have been the corrupted 2, short-paying by 8.
    await expect(firelight_vault.connect(payout_signer).payout(payout_receiver.address, 10n, periodStart))
      .to.emit(firelight_vault, "PayoutExecuted")
      .withArgs(payout_receiver.address, 10n, 10n, periodStart);

    // The slashable bucket is fully consumed and the claimant received the whole 10.
    expect(await firelight_vault.totalAssets()).to.equal(0n);
    expect(await firelight_vault.withdrawAssets(capturePeriod + 1n)).to.equal(0n);
    expect(await firelight_vault.pendingWithdrawAssets()).to.equal(0n);
    expect(await token_contract.balanceOf(payout_receiver.address)).to.equal(10n);
    expect(await token_contract.balanceOf(firelight_vault.target)).to.equal(0n);
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
