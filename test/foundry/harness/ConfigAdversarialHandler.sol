// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CoverOrderAllocator} from "contracts/core/CoverOrderAllocator.sol";
import {ICoverOrderAllocator} from "contracts/core/interfaces/ICoverOrderAllocator.sol";
import {MockCoverOrderAllocatorVault} from "contracts/test/MockCoverOrderAllocatorVault.sol";
import {MockAggregatorV3} from "contracts/test/MockAggregatorV3.sol";
import {MockERC20} from "contracts/test/MockERC20.sol";

/// @notice Fuzzes CONFIG_ADMIN parameters (effectiveLeverage, minCAR, divergenceTolerance,
/// settlementGracePeriod) within RATIONAL bounds and drives a commit each round. The paired invariant
/// asserts that capacity stays computable and commits never revert unexpectedly — i.e. the allocator
/// is robust across the *sane* config envelope. It is a regression guard for the recommended fixes:
/// today the contract's setters allow leverage == type(uint256).max and unbounded grace (see the
/// ConfigBrick PoCs), which break this property; once bounds are added this handler proves the whole
/// remaining envelope is safe. Bounds here mirror what those caps SHOULD be.
contract ConfigAdversarialHandler is Test {
    CoverOrderAllocator public allocator;
    MockCoverOrderAllocatorVault public vault;
    MockAggregatorV3 public oracle;
    MockERC20 public flbToken;
    address public custody;

    uint256 public period;
    bool public commitRevertedUnexpectedly;
    bytes public lastRevert;

    // Rational ceilings (the caps the team should enforce on-chain).
    uint256 internal constant MAX_LEVERAGE = 100; // <=100x
    uint256 internal constant MAX_MINCAR = 1_000_000; // <=100x CAR
    uint256 internal constant MAX_TOL_BPS = 1_000; // matches MAX_DIVERGENCE_TOLERANCE_BPS territory
    uint48 internal constant PERIOD_DURATION = 1 days;

    constructor(
        CoverOrderAllocator _allocator,
        MockCoverOrderAllocatorVault _vault,
        MockAggregatorV3 _oracle,
        MockERC20 _flbToken,
        address _custody
    ) {
        allocator = _allocator;
        vault = _vault;
        oracle = _oracle;
        flbToken = _flbToken;
        custody = _custody;
    }

    function setLeverageConfig(uint256 levSeed, uint256 carSeed, uint256 tolSeed) external {
        ICoverOrderAllocator.CapacityConfig memory cap = ICoverOrderAllocator.CapacityConfig({
            minCAR: bound(carSeed, 12_000, MAX_MINCAR),
            firstLossBufferToken: flbToken,
            firstLossBuffer: custody,
            effectiveLeverage: bound(levSeed, 1, MAX_LEVERAGE) * 10_000,
            minOrderMarketCoverAmount: 1e18,
            divergenceToleranceBps: uint16(bound(tolSeed, 0, MAX_TOL_BPS))
        });
        allocator.setCapacityConfig(cap);
    }

    function setGrace(uint256 graceSeed) external {
        // The full legal grace range (hard-capped at 8 hours by the setter).
        allocator.setSettlementGracePeriod(uint48(bound(graceSeed, 0, 8 hours)));
    }

    /// Move to a fresh period and commit a tiny allocation; capacity must always be computable and a
    /// within-capacity commit must never revert under sane config.
    function commitTiny(uint256 rootSeed) external {
        period++;
        vault.setCurrentPeriod(period);
        oracle.setAnswer(1e18); // refresh freshness

        bytes32 root = keccak256(abi.encode("root", rootSeed, period));
        try allocator.commitAllocation(period, root, 1, 1) {
            // capacity >= 1 and commit accepted — expected
        } catch (bytes memory reason) {
            commitRevertedUnexpectedly = true;
            lastRevert = reason;
        }
    }
}
