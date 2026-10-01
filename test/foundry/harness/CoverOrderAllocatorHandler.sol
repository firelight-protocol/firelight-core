// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CoverOrderAllocator} from "contracts/core/CoverOrderAllocator.sol";
import {ICoverOrderAllocator} from "contracts/core/interfaces/ICoverOrderAllocator.sol";
import {MockCoverOrderAllocatorVault} from "contracts/test/MockCoverOrderAllocatorVault.sol";
import {MockAggregatorV3} from "contracts/test/MockAggregatorV3.sol";
import {IFirelightVault} from "contracts/core/interfaces/IFirelightVault.sol";

/// @notice Drives the full cover-order lifecycle (create -> commit -> settle | cancel) as a serialized
/// state machine (the invariant fuzzer calls actions in random order; step guards no-op the rest).
/// One order per period => single-leaf commitment => root == leaf, empty proof. Mock vault + oracle keep
/// capacity effectively unbounded so commits/settles never revert and only the settlement-accounting
/// guards (x-ray I-3 / I-4 / I-5 / I-6) gate behaviour. Asserts run against the most recently settled order.
contract CoverOrderAllocatorHandler is Test {
    CoverOrderAllocator public allocator;
    MockCoverOrderAllocatorVault public vault;
    MockAggregatorV3 public oracle;

    address public buyer;
    address public payoutRecipient;
    bytes32 public market0;
    bytes32 public market1;
    uint48 public grace;

    enum Step {
        IDLE,
        CREATED,
        COMMITTED
    }
    Step public step;

    uint256 public period; // monotonically increasing; create uses currentPeriod=period, target=period+1
    uint256 public curOrderId;
    uint256 public orderPeriod;

    // chosen settlement payload (mirrored to storage so settle re-sends exactly what was committed)
    ICoverOrderAllocator.MarketCoverAllocation[] internal pendingAlloc;

    // last settled order, for the invariants
    bool public hasSettled;
    uint256 public lastSettledOrderId;
    uint256 public lastSettledPeriod;

    constructor(
        CoverOrderAllocator _allocator,
        MockCoverOrderAllocatorVault _vault,
        MockAggregatorV3 _oracle,
        address _buyer,
        address _payoutRecipient,
        bytes32 _market0,
        bytes32 _market1,
        uint48 _grace
    ) {
        allocator = _allocator;
        vault = _vault;
        oracle = _oracle;
        buyer = _buyer;
        payoutRecipient = _payoutRecipient;
        market0 = _market0;
        market1 = _market1;
        grace = _grace;
    }

    function createOrder(uint256 a0, uint256 a1, uint32 r0, uint32 r1) external {
        if (step != Step.IDLE) return;

        vault.setCurrentPeriod(period); // target = period + 1
        IFirelightVault.PeriodConfiguration memory pc = IFirelightVault.PeriodConfiguration({
            epoch: uint48(block.timestamp),
            duration: uint48(1 days),
            startingPeriod: period + 1
        });
        vault.setPeriodConfiguration(period + 1, pc);

        ICoverOrderAllocator.MarketAllocationInput[] memory m = new ICoverOrderAllocator.MarketAllocationInput[](2);
        m[0] = ICoverOrderAllocator.MarketAllocationInput({
            marketId: market0,
            coverRateAnnual: uint32(bound(r0, 1, 10_000)),
            coverAmount: bound(a0, 1e18, 1e24)
        });
        m[1] = ICoverOrderAllocator.MarketAllocationInput({
            marketId: market1,
            coverRateAnnual: uint32(bound(r1, 1, 10_000)),
            coverAmount: bound(a1, 1e18, 1e24)
        });

        curOrderId = allocator.createCoverOrder(
            buyer,
            payoutRecipient,
            "beneficiary",
            address(_premiumToken()),
            m,
            ICoverOrderAllocator.CoverOrderType.NEW
        );
        orderPeriod = period + 1;
        step = Step.CREATED;
    }

    function commit(uint256 c0, uint256 c1) external {
        if (step != Step.CREATED) return;

        vault.setCurrentPeriod(orderPeriod); // commitment period must equal currentPeriod
        oracle.setAnswer(1e18); // refresh updatedAt so the freshness check always passes

        ICoverOrderAllocator.MarketAllocation[] memory mk = allocator.getCoverOrderMarkets(curOrderId);
        ICoverOrderAllocator.CoverOrder memory ord = allocator.getCoverOrder(curOrderId);

        ICoverOrderAllocator.MarketCoverAllocation[] memory alloc =
            new ICoverOrderAllocator.MarketCoverAllocation[](mk.length);
        alloc[0] = ICoverOrderAllocator.MarketCoverAllocation({
            marketId: mk[0].marketId,
            allocatedCover: bound(c0, 0, mk[0].coverAmount)
        });
        alloc[1] = ICoverOrderAllocator.MarketCoverAllocation({
            marketId: mk[1].marketId,
            allocatedCover: bound(c1, 0, mk[1].coverAmount)
        });
        uint256 sumCover = alloc[0].allocatedCover + alloc[1].allocatedCover;
        if (sumCover == 0) {
            alloc[0].allocatedCover = mk[0].coverAmount; // avoid ZeroAllocation revert
            sumCover = mk[0].coverAmount;
        }

        // mirror the payload to storage for settle(); the premium is now computed
        // on-chain from the order's stored rates and period duration.
        delete pendingAlloc;
        pendingAlloc.push(alloc[0]);
        pendingAlloc.push(alloc[1]);

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(curOrderId, alloc))));
        allocator.commitAllocation(orderPeriod, leaf, sumCover, sumCover);

        step = Step.COMMITTED;
    }

    function settle() external {
        if (step != Step.COMMITTED) return;

        vm.warp(block.timestamp + uint256(grace) + 1); // clear the settlement grace period

        bytes32[] memory proof = new bytes32[](0);
        allocator.settleCoverOrder(curOrderId, pendingAlloc, proof);

        hasSettled = true;
        lastSettledOrderId = curOrderId;
        lastSettledPeriod = orderPeriod;
        period = orderPeriod; // next create targets orderPeriod + 1
        step = Step.IDLE;
    }

    function cancelCreated() external {
        if (step != Step.CREATED) return;
        allocator.cancelCoverOrder(curOrderId);
        period = orderPeriod;
        step = Step.IDLE;
    }

    function _premiumToken() internal view returns (address) {
        address[] memory toks = allocator.getSupportedPremiumTokens();
        return toks[0];
    }
}
