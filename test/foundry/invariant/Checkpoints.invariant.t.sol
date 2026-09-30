// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {CheckpointsHarness} from "../harness/CheckpointsHarness.sol";

/// @notice Drives random push/pop sequences (keys kept non-decreasing, as OZ Trace208 requires)
/// while mirroring the live values in a ghost stack, so the invariants below are checked against
/// an independent model rather than the contract's own view.
contract CheckpointsHandler is StdUtils {
    CheckpointsHarness public h;

    uint48 public lastKey;
    bool public anyPush;
    uint256[] internal ghost; // parallel stack of live values (excludes the index-0 sentinel)

    constructor(CheckpointsHarness _h) {
        h = _h;
    }

    function push(uint48 keyGap, uint256 value) external {
        uint48 gap = uint48(bound(keyGap, 0, 1_000_000));
        uint48 key;
        bool overwrite;

        if (!anyPush) {
            key = gap;
        } else if (gap == 0) {
            key = lastKey; // exercise the same-key overwrite branch
            overwrite = true;
        } else {
            if (lastKey > type(uint48).max - gap) return; // skip on overflow
            key = lastKey + gap;
        }

        h.push(key, value);

        if (overwrite) {
            ghost[ghost.length - 1] = value;
        } else {
            ghost.push(value);
        }
        lastKey = key;
        anyPush = true;
    }

    function pop() external {
        if (ghost.length == 0) return;
        h.pop();
        ghost.pop();
        if (ghost.length > 0) {
            (, uint48 k, ) = h.latestCheckpoint();
            lastKey = k;
        } else {
            lastKey = 0;
            anyPush = false;
        }
    }

    function ghostDepth() external view returns (uint256) {
        return ghost.length;
    }

    function ghostLatest() external view returns (uint256) {
        return ghost.length == 0 ? 0 : ghost[ghost.length - 1];
    }
}

/// @notice Stateful invariants for Trace256 (x-ray I-10).
contract CheckpointsInvariant is Test {
    CheckpointsHarness internal h;
    CheckpointsHandler internal handler;

    function setUp() public {
        h = new CheckpointsHarness();
        handler = new CheckpointsHandler(h);
        targetContract(address(handler));
    }

    /// I-10a: index 0 of the side array is a permanent zero sentinel once seeded.
    function invariant_sentinelAlwaysZero() public view {
        if (h.valuesLength() > 0) {
            assertEq(h.valueAt(0), 0, "sentinel must stay 0");
        }
    }

    /// I-10b: checkpoint count and side-array length stay coupled (off by the sentinel).
    function invariant_lengthCoupling() public view {
        uint256 vl = h.valuesLength();
        if (vl == 0) {
            assertEq(h.length(), 0, "empty trace, empty values");
        } else {
            assertEq(h.length(), vl - 1, "length == values - sentinel");
        }
    }

    /// Trace depth matches the independent ghost model.
    function invariant_depthMatchesGhost() public view {
        assertEq(h.length(), handler.ghostDepth(), "depth tracks ghost");
    }

    /// latest() equals the top of the ghost stack across any push/pop interleaving.
    function invariant_latestMatchesGhost() public view {
        assertEq(h.latest(), handler.ghostLatest(), "latest tracks ghost top");
    }

    /// A lookup beyond the largest key always returns the most recent value.
    function invariant_lookupBeyondMaxIsLatest() public view {
        assertEq(h.upperLookupRecent(type(uint48).max), h.latest(), "lookup>=maxKey == latest");
    }
}
