// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Checkpoints} from "../core/lib/Checkpoints.sol";

/// @title Checkpoints test harness
/// @author Zaksans
/// @notice Exposes Trace256 operations and side-array length for regression tests only.
contract CheckpointsHarness {
    using Checkpoints for Checkpoints.Trace256;

    Checkpoints.Trace256 private _trace;

    /// @notice Inserts or overwrites a checkpoint.
    /// @param key Checkpoint key.
    /// @param value Full-width checkpoint value.
    function push(uint48 key, uint256 value) external returns (uint256, uint256) {
        return _trace.push(key, value);
    }

    /// @notice Removes the last real checkpoint.
    function pop() external returns (uint256) {
        return _trace.pop();
    }

    /// @notice Returns the number of real checkpoints.
    function length() external view returns (uint256) {
        return _trace.length();
    }

    /// @notice Returns the side-array length, including the zero sentinel.
    function valuesLength() external view returns (uint256) {
        return _trace._values.length;
    }

    /// @notice Returns the latest value or zero for an empty trace.
    function latest() external view returns (uint256) {
        return _trace.latest();
    }

    /// @notice Returns the existence, key and value of the latest checkpoint.
    function latestCheckpoint() external view returns (bool, uint48, uint256) {
        return _trace.latestCheckpoint();
    }

    /// @notice Returns the checkpoint at a position.
    /// @param pos Zero-based checkpoint position.
    function at(uint32 pos) external view returns (Checkpoints.Checkpoint256 memory) {
        return _trace.at(pos);
    }

    /// @notice Returns the value at or before a key, optionally using a hint.
    /// @param key Query key.
    /// @param hint ABI-encoded uint32 position or empty bytes.
    function lookup(uint48 key, bytes calldata hint) external view returns (uint256) {
        return _trace.upperLookupRecent(key, hint);
    }

    /// @notice Returns the existence, key, value and position at or before a key.
    /// @param key Query key.
    /// @param hint ABI-encoded uint32 position or empty bytes.
    function lookupCheckpoint(uint48 key, bytes calldata hint) external view returns (bool, uint48, uint256, uint32) {
        return _trace.upperLookupRecentCheckpoint(key, hint);
    }
}
