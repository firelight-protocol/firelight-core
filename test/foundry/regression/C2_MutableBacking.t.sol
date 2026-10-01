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

/// @notice PoC for candidate finding C2: cover capacity is frozen at commit time, but the collateral
/// it is derived from — the first-loss-buffer (FLB) balance and the vault's active assets — remain
/// fully mutable afterward. The FLB is an external custody wallet counted at face value (no oracle,
/// no escrow). After a commit sized to real backing, that backing can shrink, leaving cover sold
/// against collateral that no longer exists. On an incident the payout legs (FLB balance + vault)
/// then under-pay covered recipients — direct loss, the NON-conservative mirror of F2.
///
/// This PoC proves the core defect on-chain: an allocation that was valid at commit becomes larger
/// than the freshly-recomputed capacity once the FLB is drained. `recommitAllocation` rejects the
/// same amount it just accepted — the frozen `totalDeclaredAllocated` now exceeds live backing.
contract C2MutableBacking is Test {
    CoverOrderAllocator internal allocator;
    MockCoverOrderAllocatorVault internal vault;
    MockAggregatorV3 internal oracle;
    CoverNFT internal coverNFT;
    MockERC20 internal premiumToken;
    MockERC20 internal flbToken;
    MockERC20 internal assetToken;

    address internal custody = address(0xFB); // the FLB wallet (external, not escrowed)

    uint256 internal constant FLB = 1000e18; // first-loss buffer
    uint256 internal constant ASSETS = 1000e18; // vault active assets snapshot
    // minCAR == leverage == 12000, tol == 0, price == 1 USD => capacity == FLB + ASSETS.
    uint256 internal constant CAPACITY = FLB + ASSETS; // 2000e18

    function setUp() public {
        vm.warp(1_000_000);
        assetToken = new MockERC20("Asset", "AST", 18);
        premiumToken = new MockERC20("Premium", "PRM", 18);
        flbToken = new MockERC20("FirstLoss", "FLB", 18);
        flbToken.mint(custody, FLB);

        vault = new MockCoverOrderAllocatorVault();
        vault.setAsset(address(assetToken));
        vault.setTotalAssetsAtSnapshot(ASSETS);

        oracle = new MockAggregatorV3(18, 1e18); // 1 USD, 18 decimals

        CoverNFT nftImpl = new CoverNFT();
        coverNFT = CoverNFT(address(new ERC1967Proxy(address(nftImpl), abi.encodeWithSelector(
            CoverNFT.initialize.selector, "Cover", "CVR", "", address(this), address(0), address(0), address(0)
        ))));

        allocator = _deployAllocator();
        coverNFT.grantRole(coverNFT.MINTER_ROLE(), address(allocator));
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

    function test_C2_committedCoverBecomesUnbackedAfterFLBDrain() public {
        vault.setCurrentPeriod(1);
        oracle.setAnswer(1e18); // refresh freshness

        // Commit cover exactly at capacity, fully backed at this instant.
        allocator.commitAllocation(1, keccak256("root"), CAPACITY, CAPACITY);

        ICoverOrderAllocator.AllocationCommitment memory c = allocator.getAllocationCommitment(1);
        assertEq(c.totalDeclaredAllocated, CAPACITY, "committed at capacity");
        assertEq(c.totalAvailableCapacity, CAPACITY, "capacity frozen at commit");

        // --- Backing shrinks: the external FLB custody wallet moves its funds out ---
        // (an EOA/multisig transfer the allocator neither controls nor is notified of).
        vm.prank(custody);
        flbToken.transfer(address(0xDEAD), FLB); // drain the entire first-loss buffer

        // Live backing is now only the vault assets (1000e18); the committed 2000e18 of cover is
        // half-unbacked. recommitAllocation recomputes capacity from live inputs and REJECTS the
        // very matching capacity it accepted moments ago — proving the standing commitment is
        // now oversold.
        vm.expectRevert(
            abi.encodeWithSelector(ICoverOrderAllocator.MatchingCapacityOverflow.selector, CAPACITY, ASSETS)
        );
        allocator.recommitAllocation(1, keccak256("root2"), CAPACITY, CAPACITY);

        // The frozen commitment still stands at 2000e18 while live backing is 1000e18: on an incident,
        // FLB-leg + vault-leg payouts can satisfy at most ~1000e18, under-paying covered recipients.
        assertEq(allocator.getAllocationCommitment(1).totalDeclaredAllocated, CAPACITY, "oversold commitment stands");
    }
}
