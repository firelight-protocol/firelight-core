// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Checkpoints} from "contracts/core/lib/Checkpoints.sol";

/// @notice Thin wrapper exposing the internal `Checkpoints.Trace256` library functions
/// (and the raw `_values` side array) so Foundry can unit/fuzz/invariant test them.
/// Trace256 is the variant used by FirelightVault for balance/supply/asset history.
contract CheckpointsHarness {
    using Checkpoints for Checkpoints.Trace256;

    Checkpoints.Trace256 internal trace;

    function push(uint48 key, uint256 value) external returns (uint256 prev, uint256 curr) {
        return trace.push(key, value);
    }

    function pop() external returns (uint256) {
        return trace.pop();
    }

    function latest() external view returns (uint256) {
        return trace.latest();
    }

    function latestCheckpoint() external view returns (bool, uint48, uint256) {
        return trace.latestCheckpoint();
    }

    function length() external view returns (uint256) {
        return trace.length();
    }

    function upperLookupRecent(uint48 key) external view returns (uint256) {
        return trace.upperLookupRecent(key);
    }

    function at(uint32 pos) external view returns (Checkpoints.Checkpoint256 memory) {
        return trace.at(pos);
    }

    // --- Raw side-array introspection (for the sentinel / length-coupling invariant) ---

    function valuesLength() external view returns (uint256) {
        return trace._values.length;
    }

    function valueAt(uint256 i) external view returns (uint256) {
        return trace._values[i];
    }
}
