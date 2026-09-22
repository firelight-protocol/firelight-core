// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {CoverOrderAllocator} from "contracts/core/CoverOrderAllocator.sol";
import {ICoverOrderAllocator} from "contracts/core/interfaces/ICoverOrderAllocator.sol";
import {IFirelightVault} from "contracts/core/interfaces/IFirelightVault.sol";
import {IAggregatorV3} from "contracts/core/interfaces/IAggregatorV3.sol";
import {CoverNFT} from "contracts/core/CoverNFT.sol";
import {MockERC20} from "contracts/test/MockERC20.sol";
import {MockCoverOrderAllocatorVault} from "contracts/test/MockCoverOrderAllocatorVault.sol";
import {MockAggregatorV3} from "contracts/test/MockAggregatorV3.sol";
import {CoverOrderAllocatorHandler} from "../harness/CoverOrderAllocatorHandler.sol";

/// @notice Settlement-accounting invariants for CoverOrderAllocator (x-ray I-3 / I-4 / I-5 / I-6),
/// driven through the full create/commit/settle lifecycle by the handler.
contract CoverOrderAllocatorInvariant is Test {
    CoverOrderAllocator internal allocator;
    MockCoverOrderAllocatorVault internal vault;
    MockAggregatorV3 internal oracle;
    CoverNFT internal coverNFT;
    MockERC20 internal premiumToken;
    MockERC20 internal flbToken;
    MockERC20 internal assetToken;

    CoverOrderAllocatorHandler internal handler;

    address internal buyer = address(0xB0B);
    address internal custody = address(0xFB);
    bytes32 internal market0;
    bytes32 internal market1;
    uint48 internal constant GRACE = 1 hours;

    function setUp() public {
        assetToken = new MockERC20("Asset", "AST", 18);
        premiumToken = new MockERC20("Premium", "PRM", 18);
        flbToken = new MockERC20("FirstLoss", "FLB", 18);
        flbToken.mint(custody, 1e30);

        vault = new MockCoverOrderAllocatorVault();
        vault.setAsset(address(assetToken));
        vault.setCurrentPeriod(0);
        vault.setTotalAssetsAtSnapshot(1e30);

        oracle = new MockAggregatorV3(18, 1e18); // price 1 USD, 18 decimals

        coverNFT = _deployCoverNFT();

        allocator = _deployAllocator();

        coverNFT.grantRole(coverNFT.MINTER_ROLE(), address(allocator));
        // The grace ceiling is validated against the current period's duration.
        vault.setPeriodConfiguration(
            0, IFirelightVault.PeriodConfiguration({epoch: uint48(block.timestamp), duration: 1 days, startingPeriod: 0})
        );
        allocator.setSettlementGracePeriod(GRACE);

        market0 = keccak256(abi.encode(uint64(1), "P1", bytes32("m0")));
        market1 = keccak256(abi.encode(uint64(1), "P2", bytes32("m1")));

        handler = new CoverOrderAllocatorHandler(
            allocator, vault, oracle, buyer, address(0xBEEF), market0, market1, GRACE
        );
        allocator.grantRole(allocator.CURATOR_ROLE(), address(handler));
        allocator.grantRole(allocator.ALLOCATOR_ROLE(), address(handler));

        // Fund + approve the buyer so settlement premium pulls succeed.
        premiumToken.mint(buyer, 1e30);
        vm.prank(buyer);
        premiumToken.approve(address(allocator), type(uint256).max);

        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = handler.createOrder.selector;
        selectors[1] = handler.commit.selector;
        selectors[2] = handler.settle.selector;
        selectors[3] = handler.cancelCreated.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function _deployCoverNFT() internal returns (CoverNFT) {
        CoverNFT impl = new CoverNFT();
        bytes memory initCall = abi.encodeWithSelector(
            CoverNFT.initialize.selector, "Cover", "CVR", "", address(this), address(0), address(0), address(0)
        );
        return CoverNFT(address(new ERC1967Proxy(address(impl), initCall)));
    }

    function _deployAllocator() internal returns (CoverOrderAllocator) {
        CoverOrderAllocator impl = new CoverOrderAllocator();

        address[] memory premiumTokens = new address[](1);
        premiumTokens[0] = address(premiumToken);

        ICoverOrderAllocator.ProtocolConcentrationInput[] memory concs =
            new ICoverOrderAllocator.ProtocolConcentrationInput[](2);
        concs[0] = ICoverOrderAllocator.ProtocolConcentrationInput({chainId: 1, protocol: "P1", maxProtocolConcentrationBps: 10_000});
        concs[1] = ICoverOrderAllocator.ProtocolConcentrationInput({chainId: 1, protocol: "P2", maxProtocolConcentrationBps: 10_000});

        ICoverOrderAllocator.Market[] memory markets = new ICoverOrderAllocator.Market[](2);
        markets[0] = ICoverOrderAllocator.Market({chainId: 1, protocol: "P1", market: bytes32("m0")});
        markets[1] = ICoverOrderAllocator.Market({chainId: 1, protocol: "P2", market: bytes32("m1")});

        ICoverOrderAllocator.CapacityConfig memory cap = ICoverOrderAllocator.CapacityConfig({
            minCAR: 12_000,
            firstLossBufferToken: flbToken,
            firstLossBuffer: custody,
            effectiveLeverage: 12_000,
            minOrderMarketCoverAmount: 1e18,
            divergenceToleranceBps: 0
        });

        ICoverOrderAllocator.InitParams memory p = ICoverOrderAllocator.InitParams({
            vault: IFirelightVault(address(vault)),
            premiumCollector: address(0xC0FFEE),
            coverNFT: coverNFT,
            priceFeedAdapter: IAggregatorV3(address(oracle)),
            maxPriceAge: type(uint48).max,
            premiumTokens: premiumTokens,
            admin: address(this),
            adminRole: address(this),
            curatorRole: address(this),
            allocatorRole: address(this),
            configAdminRole: address(this),
            initialProtocolConcentrations: concs,
            newMarkets: markets,
            capacityConfig: cap
        });

        bytes memory initCall = abi.encodeWithSelector(CoverOrderAllocator.initialize.selector, p);
        return CoverOrderAllocator(address(new ERC1967Proxy(address(impl), initCall)));
    }

    // --- Invariants (asserted on the most recently settled order) ---

    /// I-3: settled cover never exceeds the declared allocation for the period.
    function invariant_settledWithinDeclared() public view {
        if (!handler.hasSettled()) return;
        ICoverOrderAllocator.AllocationCommitment memory c =
            allocator.getAllocationCommitment(handler.lastSettledPeriod());
        assertLe(c.totalSettledCover, c.totalDeclaredAllocated, "settled > declared");
    }

    /// I-5: an order's allocations never exceed what was requested; MATCHED implies exact full cover.
    function invariant_orderWithinRequested() public view {
        if (!handler.hasSettled()) return;
        ICoverOrderAllocator.CoverOrder memory o = allocator.getCoverOrder(handler.lastSettledOrderId());
        assertLe(o.allocatedCoverAmount, o.totalCoverAmount, "cover > requested");
        assertLe(o.allocatedPremiumAmount, o.totalPremiumAmount, "premium > requested");
        if (o.status == ICoverOrderAllocator.CoverOrderStatus.MATCHED) {
            assertEq(o.allocatedCoverAmount, o.totalCoverAmount, "MATCHED but cover != total");
            assertEq(o.allocatedPremiumAmount, o.totalPremiumAmount, "MATCHED but premium != total");
        }
    }

    /// Per-market allocations sum to the order's allocated cover.
    function invariant_perMarketSumMatchesOrder() public view {
        if (!handler.hasSettled()) return;
        uint256 id = handler.lastSettledOrderId();
        ICoverOrderAllocator.CoverOrder memory o = allocator.getCoverOrder(id);
        ICoverOrderAllocator.MarketAllocation[] memory mk = allocator.getCoverOrderMarkets(id);
        uint256 sum;
        for (uint256 i = 0; i < mk.length; i++) {
            sum += mk[i].allocatedCoverAmount;
        }
        assertEq(sum, o.allocatedCoverAmount, "per-market sum != order allocated");
    }

    /// I-4: per-protocol settled cover stays within concentration cap (bps * capacity / 10000).
    function invariant_concentrationWithinCap() public view {
        if (!handler.hasSettled()) return;
        uint256 p = handler.lastSettledPeriod();
        ICoverOrderAllocator.AllocationCommitment memory c = allocator.getAllocationCommitment(p);

        _assertConcWithinCap("P1", p, c.totalAvailableCapacity);
        _assertConcWithinCap("P2", p, c.totalAvailableCapacity);
    }

    function _assertConcWithinCap(string memory protocol, uint256 p, uint256 capacity) internal view {
        bytes32 hash = keccak256(abi.encode(uint64(1), protocol));
        uint256 settled = allocator.getProtocolConcentrationSettledCover(p, hash);
        uint256 cap = (allocator.getProtocolConcentrationAt(hash, p) * capacity) / 10_000;
        assertLe(settled, cap, "concentration settled > cap");
    }
}
