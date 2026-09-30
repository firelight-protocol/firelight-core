// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {IncidentManager} from "contracts/core/IncidentManager.sol";
import {IIncidentManager} from "contracts/core/interfaces/IIncidentManager.sol";
import {ICoverOrderAllocator} from "contracts/core/interfaces/ICoverOrderAllocator.sol";
import {IAggregatorV3} from "contracts/core/interfaces/IAggregatorV3.sol";
import {MockERC20} from "contracts/test/MockERC20.sol";
import {MockIncidentManagerVault} from "contracts/test/MockIncidentManagerVault.sol";
import {MockIncidentManagerCoverOrderAllocator} from "contracts/test/MockIncidentManagerCoverOrderAllocator.sol";
import {MockAggregatorV3} from "contracts/test/MockAggregatorV3.sol";
import {IncidentManagerHandler} from "../harness/IncidentManagerHandler.sol";

/// @notice State-machine + FIFO + active-counter invariants for IncidentManager (x-ray I-7, I-9/G-17, X-1).
contract IncidentManagerInvariant is Test {
    IncidentManager internal im;
    MockIncidentManagerVault internal vault;
    MockIncidentManagerCoverOrderAllocator internal allocator;
    MockAggregatorV3 internal oracle;
    MockERC20 internal assetToken;
    MockERC20 internal flbToken;
    IncidentManagerHandler internal handler;

    address internal custody = address(0xFB);
    address internal payoutReceiver = address(0xCAFE);
    address internal payoutRecipient = address(0xD00D);
    uint48 internal baseTs;

    function setUp() public {
        vm.warp(1_000_000); // default test timestamp is 1; move forward so capture timestamps stay positive

        assetToken = new MockERC20("Asset", "AST", 18);
        flbToken = new MockERC20("FirstLoss", "FLB", 18);
        // custody holds 0 FLB -> payout waterfall skips FLB and goes straight to the vault.

        vault = new MockIncidentManagerVault();
        vault.setAsset(address(assetToken));
        vault.setCurrentPeriod(1);

        allocator = new MockIncidentManagerCoverOrderAllocator();
        allocator.setVault(vault);
        allocator.setCanonicalDecimals(18);

        oracle = new MockAggregatorV3(18, 1e18);

        IncidentManager impl = new IncidentManager();
        bytes memory initCall = abi.encodeWithSelector(
            IncidentManager.initialize.selector,
            address(this), // admin
            address(this), // curator
            address(this), // approver
            address(this), // rejecter
            address(this), // invalidator
            address(this), // configAdmin
            address(this), // payoutAdmin
            address(this), // priceFeedAdmin
            payoutReceiver,
            allocator,
            IAggregatorV3(address(oracle)),
            type(uint48).max // maxPriceAge
        );
        im = IncidentManager(address(new ERC1967Proxy(address(impl), initCall)));

        // Capacity config consumed by the payout waterfall (only FLB token + custody matter here).
        ICoverOrderAllocator.CapacityConfig memory cap = ICoverOrderAllocator.CapacityConfig({
            minCAR: 12_000,
            firstLossBufferToken: flbToken,
            firstLossBuffer: custody,
            effectiveLeverage: 12_000,
            minOrderMarketCoverAmount: 1e18,
            divergenceToleranceBps: 0
        });
        allocator.setMockCapacityConfig(cap);

        // A settled cover order-market the assessment losses can reference.
        allocator.setOrderMarket(1, bytes32(uint256(0xAA)), 1, 1e30, payoutRecipient);

        // Capture timestamps live in [baseTs, baseTs + POOL) and all map to period 1, all <= now.
        baseTs = uint48(block.timestamp) - uint48(100);
        for (uint256 i = 0; i < 40; i++) {
            vault.setPeriodAtTimestamp(baseTs + uint48(i), 1);
        }

        handler = new IncidentManagerHandler(im, vault, baseTs);
        im.grantRole(im.CURATOR_ROLE(), address(handler));
        im.grantRole(im.ASSESSMENT_APPROVER_ROLE(), address(handler));
        im.grantRole(im.ASSESSMENT_REJECTER_ROLE(), address(handler));
        im.grantRole(im.INCIDENT_INVALIDATOR_ROLE(), address(handler));

        bytes4[] memory selectors = new bytes4[](8);
        selectors[0] = handler.createIncident.selector;
        selectors[1] = handler.confirm.selector;
        selectors[2] = handler.addLosses.selector;
        selectors[3] = handler.submit.selector;
        selectors[4] = handler.approveSpecific.selector;
        selectors[5] = handler.reject.selector;
        selectors[6] = handler.cancelPre.selector;
        selectors[7] = handler.cancelInc.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// I-7: once an incident reaches a terminal status (CLOSED/CANCELED) it never changes.
    function invariant_terminalIncidentsImmutable() public view {
        uint256[] memory ids = handler.getIncidentIds();
        for (uint256 i = 0; i < ids.length; i++) {
            uint256 id = ids[i];
            if (!handler.terminalRecorded(id)) continue;
            (IIncidentManager.Incident memory inc, bool ok) = im.getIncident(id);
            assertTrue(ok, "terminal incident vanished");
            assertEq(uint8(inc.status), uint8(handler.terminalStatus(id)), "terminal status mutated");
        }
    }

    /// Manager side of X-1: the active counter equals the number of non-terminal incidents.
    function invariant_activeCountMatchesGhost() public view {
        assertEq(im.activeIncidentCount(handler.PERIOD()), handler.ghostActive(), "active count != ghost");
    }

    /// I-9 / G-17: an assessment can only be approved in FIFO order (earliest capture timestamp first).
    function invariant_fifoApprovalOrder() public view {
        assertFalse(handler.fifoViolated(), "approval jumped the FIFO queue");
    }

    /// I-8 (partial): a CLOSED incident's current assessment round is APPROVED.
    function invariant_closedImpliesApprovedRound() public view {
        uint256[] memory ids = handler.getIncidentIds();
        for (uint256 i = 0; i < ids.length; i++) {
            uint256 id = ids[i];
            if (!handler.terminalRecorded(id)) continue;
            if (handler.terminalStatus(id) != IIncidentManager.IncidentStatus.CLOSED) continue;
            (IIncidentManager.AssessmentRound memory round, bool ok) = im.getCurrentAssessmentRound(id);
            assertTrue(ok, "closed incident has no round");
            assertEq(uint8(round.status), uint8(IIncidentManager.AssessmentRoundStatus.APPROVED), "closed but round not approved");
        }
    }
}
