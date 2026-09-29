const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')
const { expect } = require('chai')
const { ethers } = require('hardhat')

const encodeHint = (index) => ethers.AbiCoder.defaultAbiCoder().encode(['uint32'], [index])
const MAX_KEY = (1n << 48n) - 1n

async function deployCheckpoints() {
  const trace = await (await ethers.getContractFactory('CheckpointsHarness')).deploy()
  await trace.waitForDeployment()
  return trace
}

describe('Checkpoints Trace256', function () {
  it('returns zero and no checkpoint for an empty trace', async function () {
    const trace = await loadFixture(deployCheckpoints)
    expect(await trace.length()).to.equal(0)
    expect(await trace.latest()).to.equal(0)
    expect(await trace.latestCheckpoint()).to.deep.equal([false, 0n, 0n])
    expect(await trace.lookup(MAX_KEY, '0x')).to.equal(0)
    expect(await trace.lookupCheckpoint(MAX_KEY, '0x')).to.deep.equal([false, 0n, 0n, 0n])
    await expect(trace.pop()).to.be.revertedWithCustomError(trace, 'SystemCheckpoint')
  })

  it('keeps key zero and a zero-valued checkpoint distinct from an absent checkpoint', async function () {
    const trace = await loadFixture(deployCheckpoints)
    expect(await trace.push.staticCall(0, 0)).to.deep.equal([0n, 0n])
    await trace.push(0, 0)
    expect(await trace.lookupCheckpoint(0, '0x')).to.deep.equal([true, 0n, 0n, 0n])
    expect(await trace.latestCheckpoint()).to.deep.equal([true, 0n, 0n])
    expect(await trace.valuesLength()).to.equal(2)
  })

  it('overwrites an equal key without appending a side-array value', async function () {
    const trace = await loadFixture(deployCheckpoints)
    await trace.push(10, 1n << 240n)
    expect(await trace.push.staticCall(10, ethers.MaxUint256)).to.deep.equal([1n << 240n, ethers.MaxUint256])
    await trace.push(10, ethers.MaxUint256)
    expect(await trace.length()).to.equal(1)
    expect(await trace.valuesLength()).to.equal(2)
    expect(await trace.latest()).to.equal(ethers.MaxUint256)
    expect(await trace.at(0)).to.deep.equal([10n, ethers.MaxUint256])
    expect(await trace.lookup(9, '0x')).to.equal(0)
    expect(await trace.lookup(10, encodeHint(0))).to.equal(ethers.MaxUint256)
  })

  it('rejects decreasing keys without changing the trace', async function () {
    const trace = await loadFixture(deployCheckpoints)
    await trace.push(10, 100)
    await expect(trace.push(9, 200)).to.be.revertedWithCustomError(trace, 'CheckpointUnorderedInsertion')
    expect(await trace.length()).to.equal(1)
    expect(await trace.valuesLength()).to.equal(2)
    expect(await trace.latestCheckpoint()).to.deep.equal([true, 10n, 100n])
  })

  it('preserves the sentinel after popping every checkpoint and accepts a fresh lower key', async function () {
    const trace = await loadFixture(deployCheckpoints)
    await trace.push(10, ethers.MaxUint256)
    await trace.push(20, 1n << 240n)
    expect(await trace.pop.staticCall()).to.equal(1n << 240n)
    await trace.pop()
    expect(await trace.latest()).to.equal(ethers.MaxUint256)
    expect(await trace.valuesLength()).to.equal(2)
    await trace.pop()
    expect(await trace.length()).to.equal(0)
    expect(await trace.valuesLength()).to.equal(1)
    expect(await trace.lookupCheckpoint(MAX_KEY, '0x')).to.deep.equal([false, 0n, 0n, 0n])
    await expect(trace.pop()).to.be.revertedWithCustomError(trace, 'SystemCheckpoint')
    await trace.push(1, 77)
    expect(await trace.at(0)).to.deep.equal([1n, 77n])
    expect(await trace.valuesLength()).to.equal(2)
  })

  for (const count of [1, 5, 6, 17]) {
    it(`matches a linear model with ${count} checkpoints, including stale valid hints`, async function () {
      const trace = await loadFixture(deployCheckpoints)
      const model = []
      for (let i = 0; i < count; i++) {
        const key = BigInt(10 + i * 7)
        const value = i % 3 === 0 ? 0n : (1n << 240n) + BigInt(i)
        await trace.push(key, value)
        model.push({ key, value })
      }
      const queries = [0n, MAX_KEY, ...model.flatMap(({ key }) => [key - 1n, key, key + 1n])]
      for (const query of queries) {
        const index = model.findLastIndex(({ key }) => key <= query)
        const expected = index < 0 ? [false, 0n, 0n, 0n] :
          [true, model[index].key, model[index].value, BigInt(index)]
        const hints = new Set(['0x', encodeHint(0), encodeHint(count - 1)])
        if (index >= 0) hints.add(encodeHint(index))
        for (const hint of hints) {
          expect(await trace.lookup(query, hint)).to.equal(expected[2])
          expect(await trace.lookupCheckpoint(query, hint)).to.deep.equal(expected)
        }
      }
    })
  }

  it('supports the largest uint48 key and full uint256 value', async function () {
    const trace = await loadFixture(deployCheckpoints)
    await trace.push(MAX_KEY, ethers.MaxUint256)
    expect(await trace.lookup(MAX_KEY - 1n, '0x')).to.equal(0)
    expect(await trace.lookupCheckpoint(MAX_KEY, encodeHint(0)))
      .to.deep.equal([true, MAX_KEY, ethers.MaxUint256, 0n])
  })
})
