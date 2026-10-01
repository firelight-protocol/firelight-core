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

/// @notice Regression tests for two historical CONFIG-induced bricks in CoverOrderAllocator
/// (both required a CONFIG_ADMIN mistake, not an unprivileged attacker; both silently disabled
/// the core product). Each is now rejected at its setter, and these tests pin that behavior:
///   C1 — `settlementGracePeriod` had no upper bound: a grace >= the time remaining in the period
///        made the two settle gates contradictory (GracePeriodActive while in-period,
///        SettleWindowExpired after) and every order expired unsettled. Now hard-capped at
///        8 hours (at most a third of any period, given the vault's 1-day duration granularity).
///        The same dead window could also be produced by committing within the last `grace`
///        seconds of the period; `commitAllocation` now rejects such commits up front.
///   L1 — `effectiveLeverage` had no upper bound: a huge value overflowed the capacity `mulDiv`,
///        reverting every commitAllocation. Now capped relative to `minCAR`.
contract ConfigBrick is Test {
    CoverOrderAllocator internal allocator;
    MockCoverOrderAllocatorVault internal vault;
    MockAggregatorV3 internal oracle;
    CoverNFT internal coverNFT;
    MockERC20 internal premiumToken;
    MockERC20 internal flbToken;
    MockERC20 internal assetToken;

    address internal custody = address(0xFB);
    address internal buyer = address(0xB0B);
    bytes32 internal market0;
    uint48 internal constant PERIOD_DURATION = 1 days;

    function setUp() public {
        vm.warp(1_000_000);
        assetToken = new MockERC20("Asset", "AST", 18);
        premiumToken = new MockERC20("Premium", "PRM", 18);
        flbToken = new MockERC20("FirstLoss", "FLB", 18);
        flbToken.mint(custody, 1e24);

        vault = new MockCoverOrderAllocatorVault();
        vault.setAsset(address(assetToken));
        vault.setTotalAssetsAtSnapshot(1e24);

        oracle = new MockAggregatorV3(18, 1e18);

        CoverNFT nftImpl = new CoverNFT();
        coverNFT = CoverNFT(address(new ERC1967Proxy(address(nftImpl), abi.encodeWithSelector(
            CoverNFT.initialize.selector, "Cover", "CVR", "", address(this), address(0), address(0), address(0)
        ))));

        allocator = _deployAllocator();
        coverNFT.grantRole(coverNFT.MINTER_ROLE(), address(allocator));

        market0 = keccak256(abi.encode(uint64(1), "P1", bytes32("m0")));

        premiumToken.mint(buyer, 1e30);
        vm.prank(buyer);
        premiumToken.approve(address(allocator), type(uint256).max);
    }

    // ---- C1: an oversized settlementGracePeriod used to brick the period's settlement
    // (grace not elapsed while in-period, period rolled over once it elapsed). Fixed by
    // the hard 8-hour ceiling: the setter rejects any grace above it, so the grace can
    // never consume the settle window of any period. ----

    function test_C1_gracePeriodCappedAtEightHours() public {
        uint48 maxGrace = 8 hours;

        // Order created for period 1 (configures its 1-day duration), now current.
        uint256 orderId = _createOrder(1e21);
        vault.setCurrentPeriod(1);
        oracle.setAnswer(1e18);

        // 2 days of grace on a 1-day period: rejected at the setter.
        vm.expectRevert(abi.encodeWithSelector(ICoverOrderAllocator.InvalidGracePeriod.selector, 2 days, maxGrace));
        allocator.setSettlementGracePeriod(2 days);

        // Just above the ceiling: rejected. At the ceiling: accepted.
        vm.expectRevert(abi.encodeWithSelector(ICoverOrderAllocator.InvalidGracePeriod.selector, maxGrace + 1, maxGrace));
        allocator.setSettlementGracePeriod(maxGrace + 1);
        allocator.setSettlementGracePeriod(maxGrace);

        // The settle window survives the maximal grace: commit, wait it out, settle.
        (ICoverOrderAllocator.MarketCoverAllocation[] memory alloc,) = _commit(orderId, 1e21);
        vm.warp(block.timestamp + uint256(maxGrace) + 1);
        bytes32[] memory proof = new bytes32[](0);
        allocator.settleCoverOrder(orderId, alloc, proof);
    }

    // ---- C1 companion: a commit or recommit inside the last `grace` seconds of the period
    // would store a grace window past the period end, leaving no instant at which settlement
    // is possible. Both are rejected up front; a late root swap requires lowering the grace
    // first so the fresh window fits (or cancelCommitAllocation to withdraw without replacing). ----

    function test_C1_commitAndRecommitRejectedWithinGraceOfPeriodEnd() public {
        uint48 maxGrace = 8 hours;
        vault.setCurrentPeriod(1);
        oracle.setAnswer(1e18);
        allocator.setSettlementGracePeriod(maxGrace);

        uint48 end = uint48(block.timestamp) + PERIOD_DURATION;
        vault.setCurrentPeriodEnd(end);

        // Last instant where the grace window still fits: accepted.
        vm.warp(end - maxGrace - 1);
        allocator.commitAllocation(1, keccak256("root"), 1e18, 1e18);

        // One second later (timestamp + grace == period end): recommit rejected too.
        vm.warp(end - maxGrace);
        vm.expectRevert(ICoverOrderAllocator.CommitTooCloseToPeriodEnd.selector);
        allocator.recommitAllocation(1, keccak256("root2"), 1e18, 1e18);

        // Lowering the grace lets the swap through, and the fresh window fits in-period.
        allocator.setSettlementGracePeriod(0);
        allocator.recommitAllocation(1, keccak256("root2"), 1e18, 1e18);

        // A fresh commit at this point is equally guarded.
        allocator.setSettlementGracePeriod(maxGrace);
        allocator.cancelCommitAllocation(1);
        vm.expectRevert(ICoverOrderAllocator.CommitTooCloseToPeriodEnd.selector);
        allocator.commitAllocation(1, keccak256("root"), 1e18, 1e18);
    }

    // ---- L1: unbounded effectiveLeverage used to overflow capacity and brick all commits.
    // Fixed by the relative cap (effectiveLeverage <= MAX_LEVERAGE_FACTOR * minCAR): the
    // setter now rejects the config, so the overflow path is unreachable. ----

    function test_L1_hugeLeverageRejectedAtSetter() public {
        ICoverOrderAllocator.CapacityConfig memory cap = ICoverOrderAllocator.CapacityConfig({
            minCAR: 12_000,
            firstLossBufferToken: flbToken,
            firstLossBuffer: custody,
            effectiveLeverage: type(uint256).max,
            minOrderMarketCoverAmount: 1e18,
            divergenceToleranceBps: 0
        });
        vm.expectRevert(ICoverOrderAllocator.InvalidLeverage.selector);
        allocator.setCapacityConfig(cap);

        // Just above the relative cap: same rejection.
        cap.effectiveLeverage = 5 * 12_000 + 1;
        vm.expectRevert(ICoverOrderAllocator.InvalidLeverage.selector);
        allocator.setCapacityConfig(cap);

        // At the cap: accepted, and commits keep working (no brick).
        cap.effectiveLeverage = 5 * 12_000;
        allocator.setCapacityConfig(cap);
        vault.setCurrentPeriod(2); // config effective next period; use a later period
        oracle.setAnswer(1e18);
        allocator.commitAllocation(2, keccak256("root"), 1e18, 1e18);
    }

    // ---- helpers ----

    function _createOrder(uint256 coverAmount) internal returns (uint256 orderId) {
        vault.setCurrentPeriod(0); // create targets currentPeriod + 1 == 1
        IFirelightVault.PeriodConfiguration memory pc = IFirelightVault.PeriodConfiguration({
            epoch: uint48(block.timestamp),
            duration: PERIOD_DURATION,
            startingPeriod: 1
        });
        vault.setPeriodConfiguration(1, pc);
        ICoverOrderAllocator.MarketAllocationInput[] memory m = new ICoverOrderAllocator.MarketAllocationInput[](1);
        m[0] = ICoverOrderAllocator.MarketAllocationInput({
            marketId: market0,
            coverRateAnnual: 100,
            coverAmount: coverAmount
        });
        orderId = allocator.createCoverOrder(
            buyer, address(0xBEEF), "beneficiary", address(premiumToken), m, ICoverOrderAllocator.CoverOrderType.NEW
        );
    }

    function _commit(uint256 orderId, uint256 amount)
        internal
        returns (ICoverOrderAllocator.MarketCoverAllocation[] memory alloc, bytes32 leaf)
    {
        alloc = new ICoverOrderAllocator.MarketCoverAllocation[](1);
        alloc[0] = ICoverOrderAllocator.MarketCoverAllocation({marketId: market0, allocatedCover: amount});
        leaf = keccak256(bytes.concat(keccak256(abi.encode(orderId, alloc))));
        allocator.commitAllocation(1, leaf, amount, amount);
    }

    function _deployAllocator() internal returns (CoverOrderAllocator) {
        CoverOrderAllocator impl = new CoverOrderAllocator();

        address[] memory premiumTokens = new address[](1);
        premiumTokens[0] = address(premiumToken);

        ICoverOrderAllocator.ProtocolConcentrationInput[] memory concs =
            new ICoverOrderAllocator.ProtocolConcentrationInput[](1);
        concs[0] = ICoverOrderAllocator.ProtocolConcentrationInput({chainId: 1, protocol: "P1", maxProtocolConcentrationBps: 10_000});

        ICoverOrderAllocator.Market[] memory markets = new ICoverOrderAllocator.Market[](1);
        markets[0] = ICoverOrderAllocator.Market({chainId: 1, protocol: "P1", market: bytes32("m0")});

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
}
