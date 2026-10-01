// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

/**
 * @notice Test-only mock of the subset of `FtsoV2Interface` that the
 *         `PriceReaderChainlink*` family depends on.
 *
 *         Per-feed configuration:
 *           - `setPrice(id, value, timestamp)` — sets what the next read
 *             will return.
 *           - `setFee(id, fee)` — sets the fee that `calculateFeeById`
 *             reports and that `getFeedByIdInWei` requires.
 *
 *         `setMutating(true)` flips the read into a state-modifying path
 *         (bumps a counter on every read). This is used by the View-side
 *         tests to verify that `STATICCALL` fails the moment FTSO starts
 *         touching storage — i.e. the moment Flare turns fees on.
 */
contract MockFtsoV2 {
    mapping(bytes21 => uint256) public feeOf;
    mapping(bytes21 => uint256) public priceOf;
    mapping(bytes21 => uint64) public tsOf;

    bool public mutating;
    uint256 public mutationCounter;

    function setFee(bytes21 id, uint256 newFee) external {
        feeOf[id] = newFee;
    }

    function setPrice(bytes21 id, uint256 priceWei, uint64 timestamp) external {
        priceOf[id] = priceWei;
        tsOf[id] = timestamp;
    }

    function setMutating(bool v) external {
        mutating = v;
    }

    function calculateFeeById(bytes21 id) external view returns (uint256) {
        return feeOf[id];
    }

    function getFeedByIdInWei(bytes21 id)
        external
        payable
        returns (uint256 value, uint64 timestamp)
    {
        if (mutating) {
            // Force a storage write so STATICCALL paths revert. Simulates
            // FTSO turning fee bookkeeping on.
            mutationCounter += 1;
        }
        require(msg.value >= feeOf[id], "MockFtsoV2: fee");
        return (priceOf[id], tsOf[id]);
    }
}
