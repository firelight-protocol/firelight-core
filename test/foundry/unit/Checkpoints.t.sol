// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CheckpointsHarness} from "../harness/CheckpointsHarness.sol";
import {Checkpoints} from "contracts/core/lib/Checkpoints.sol";

/// @notice Unit + fuzz tests for the custom Trace256 checkpoint library.
/// Targets invariant I-10 (x-ray): `_values[0] == 0` sentinel, `length == _values.length - 1`,
/// non-decreasing keys, and `upperLookupRecent(k)` = value at largest key <= k (or 0).
contract CheckpointsTest is Test {
    CheckpointsHarness internal h;

    function setUp() public {
        h = new CheckpointsHarness();
    }

    // --- Empty state ---

    function test_empty_returnsZeroes() public view {
        assertEq(h.length(), 0, "length");
        assertEq(h.latest(), 0, "latest");
        assertEq(h.valuesLength(), 0, "values empty before first push");
        assertEq(h.upperLookupRecent(0), 0, "lookup low");
        assertEq(h.upperLookupRecent(type(uint48).max), 0, "lookup high");
        (bool exists, uint48 k, uint256 v) = h.latestCheckpoint();
        assertFalse(exists, "no checkpoint");
        assertEq(k, 0);
        assertEq(v, 0);
    }

    function test_empty_popReverts() public {
        vm.expectRevert(Checkpoints.SystemCheckpoint.selector);
        h.pop();
    }

    // --- Single push ---

    function test_singlePush_sentinelAndValue() public {
        (uint256 prev, uint256 curr) = h.push(100, 42);
        assertEq(prev, 0, "prev on first push is 0");
        assertEq(curr, 42, "curr");

        assertEq(h.length(), 1, "length");
        assertEq(h.valuesLength(), 2, "sentinel + 1 value");
        assertEq(h.valueAt(0), 0, "index 0 is the zero sentinel");
        assertEq(h.valueAt(1), 42, "real value at index 1");
        assertEq(h.latest(), 42, "latest");
    }

    function test_singlePush_lookupBoundaries() public {
        h.push(100, 42);
        assertEq(h.upperLookupRecent(99), 0, "before key -> sentinel 0");
        assertEq(h.upperLookupRecent(100), 42, "at key");
        assertEq(h.upperLookupRecent(101), 42, "after key");
    }

    // --- Overwrite same key ---

    function test_sameKey_overwritesInPlace() public {
        h.push(100, 42);
        (uint256 prev, uint256 curr) = h.push(100, 43);
        assertEq(prev, 42, "prev is old value");
        assertEq(curr, 43, "curr is new value");
        assertEq(h.length(), 1, "no new checkpoint");
        assertEq(h.valuesLength(), 2, "no new value slot");
        assertEq(h.latest(), 43, "overwritten");
        assertEq(h.upperLookupRecent(100), 43);
    }

    // --- Multiple ascending pushes ---

    function test_multiPush_lookupAcrossRanges() public {
        h.push(10, 1);
        h.push(20, 2);
        h.push(30, 3);

        assertEq(h.length(), 3);
        assertEq(h.valuesLength(), 4, "sentinel + 3");

        assertEq(h.upperLookupRecent(5), 0, "before first");
        assertEq(h.upperLookupRecent(10), 1);
        assertEq(h.upperLookupRecent(15), 1, "gap -> previous");
        assertEq(h.upperLookupRecent(20), 2);
        assertEq(h.upperLookupRecent(25), 2);
        assertEq(h.upperLookupRecent(30), 3);
        assertEq(h.upperLookupRecent(35), 3, "after last -> latest");

        assertEq(h.at(0)._key, 10);
        assertEq(h.at(0)._value, 1);
        assertEq(h.at(2)._key, 30);
        assertEq(h.at(2)._value, 3);
    }

    // --- Monotonic key enforcement (delegated to OZ Trace208) ---

    function test_decreasingKey_reverts() public {
        h.push(20, 1);
        vm.expectRevert(); // OZ CheckpointUnorderedInsertion
        h.push(10, 2);
    }

    // --- Pop semantics ---

    function test_pop_restoresPrevious() public {
        h.push(10, 1);
        h.push(20, 2);

        uint256 popped = h.pop();
        assertEq(popped, 2, "returns last value");
        assertEq(h.length(), 1, "length back to 1");
        assertEq(h.valuesLength(), 2, "values back to sentinel + 1");
        assertEq(h.latest(), 1, "latest is previous");
        assertEq(h.upperLookupRecent(20), 1, "lookup falls back to previous");
    }

    function test_pop_toEmpty_keepsSentinel() public {
        h.push(10, 1);
        h.pop();
        assertEq(h.length(), 0, "trace empty");
        assertEq(h.valuesLength(), 1, "sentinel remains");
        assertEq(h.valueAt(0), 0, "sentinel still 0");
        assertEq(h.latest(), 0);

        vm.expectRevert(Checkpoints.SystemCheckpoint.selector);
        h.pop();
    }

    // --- Fuzz: single push round-trips through lookup ---

    function testFuzz_singlePush_lookup(uint48 key, uint256 value) public {
        h.push(key, value);
        assertEq(h.latest(), value);
        assertEq(h.upperLookupRecent(key), value, "at key");
        if (key < type(uint48).max) {
            assertEq(h.upperLookupRecent(key + 1), value, "after key");
        }
        if (key > 0) {
            assertEq(h.upperLookupRecent(key - 1), 0, "before key -> sentinel");
        }
        assertEq(h.valueAt(0), 0, "sentinel intact");
    }

    // --- Fuzz: ascending sequence preserves length coupling and last-value lookup ---

    function testFuzz_ascendingSequence(uint48[10] calldata gaps, uint256[10] calldata values) public {
        uint48 key = 0;
        uint256 lastValue;
        uint256 pushed;
        for (uint256 i = 0; i < 10; i++) {
            uint48 gap = uint48(bound(gaps[i], 1, 1_000_000)); // strictly increasing keys
            if (key > type(uint48).max - gap) break; // avoid overflow
            key += gap;
            h.push(key, values[i]);
            lastValue = values[i];
            pushed++;
        }
        assertEq(h.length(), pushed, "one checkpoint per push");
        assertEq(h.valuesLength(), pushed + 1, "sentinel + N values");
        assertEq(h.valueAt(0), 0, "sentinel intact");
        if (pushed > 0) {
            assertEq(h.latest(), lastValue, "latest == last pushed");
            assertEq(h.upperLookupRecent(key), lastValue, "lookup at max key");
            assertEq(h.upperLookupRecent(type(uint48).max), lastValue, "lookup beyond max key");
        }
    }
}
