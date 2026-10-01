// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {CoverOrderAllocator} from "contracts/core/CoverOrderAllocator.sol";
import {ICoverOrderAllocator} from "contracts/core/interfaces/ICoverOrderAllocator.sol";
import {IFirelightVault} from "contracts/core/interfaces/IFirelightVault.sol";
import {IAggregatorV3} from "contracts/core/interfaces/IAggregatorV3.sol";
import {CoverNFT} from "contracts/core/CoverNFT.sol";
import {MockERC20} from "contracts/test/MockERC20.sol";
import {MockCoverOrderAllocatorVault} from "contracts/test/MockCoverOrderAllocatorVault.sol";
import {MockAggregatorV3} from "contracts/test/MockAggregatorV3.sol";
import {ConfigAdversarialHandler} from "../harness/ConfigAdversarialHandler.sol";

/// @notice Adversarial CONFIG fuzzing: over the RATIONAL config envelope (bounded leverage / minCAR /
/// tolerance / grace) the allocator's capacity math must never overflow and a within-capacity commit
/// must never revert. Complements the deterministic ConfigBrick PoCs, which show the UNBOUNDED
/// envelope the setters currently allow does break this. Once the recommended caps are added on-chain,
/// this invariant guards the entire remaining space.
contract ConfigInvariant is Test {
    CoverOrderAllocator internal allocator;
    MockCoverOrderAllocatorVault internal vault;
    MockAggregatorV3 internal oracle;
    CoverNFT internal coverNFT;
    MockERC20 internal premiumToken;
    MockERC20 internal flbToken;
    MockERC20 internal assetToken;
    ConfigAdversarialHandler internal handler;

    address internal custody = address(0xFB);

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

        handler = new ConfigAdversarialHandler(allocator, vault, oracle, flbToken, custody);
        allocator.grantRole(allocator.CONFIG_ADMIN_ROLE(), address(handler));
        allocator.grantRole(allocator.ALLOCATOR_ROLE(), address(handler));

        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = handler.setLeverageConfig.selector;
        selectors[1] = handler.setGrace.selector;
        selectors[2] = handler.commitTiny.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// Capacity is always computable and a within-capacity commit never reverts under sane config.
    function invariant_commitNeverRevertsUnderSaneConfig() public view {
        if (handler.commitRevertedUnexpectedly()) {
            console.logBytes(handler.lastRevert());
        }
        assertFalse(handler.commitRevertedUnexpectedly(), "commit reverted under rational config");
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
