// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ICoverOrderAllocator} from "../core/interfaces/ICoverOrderAllocator.sol";
import {IFirelightVault} from "../core/interfaces/IFirelightVault.sol";
import {IAggregatorV3} from "../core/interfaces/IAggregatorV3.sol";
import {CoverNFT} from "../core/CoverNFT.sol";

/**
 *
 *      IncidentManager only consumes a small slice of the CoverOrderAllocator surface:
 *        - `vault()`                        (read once in initialize)
 *        - `CANONICAL_DECIMALS()`           (read once in initialize)
 *        - `getCoverOrderMarketInfo(...)`    (read per assessment loss)
 *        - `getCapacityConfigAt(period)`    (read inside _executePayout — FLB token + payer
 *                                          come from the period's CapacityConfig)
 *
 *      Everything else in ICoverOrderAllocator is stubbed to safe zero / no-op so the
 *      mock satisfies the interface but is not exercised beyond IncidentManager's needs.
 */
contract MockIncidentManagerCoverOrderAllocator is ICoverOrderAllocator {
    struct OrderMarket {
        uint256 period;
        uint256 allocatedCoverAmount;
        address payoutRecipient;
    }

    IFirelightVault private _vault;
    uint8 private _canonicalDecimals = 18;
    CapacityConfig private _capacityConfig;
    mapping(uint256 coverTokenId => mapping(bytes32 marketId => OrderMarket)) private _orderMarkets;

    // -------------------------------------------------------------------------
    // Test setters
    // -------------------------------------------------------------------------

    function setVault(IFirelightVault v) external { _vault = v; }
    function setCanonicalDecimals(uint8 d) external { _canonicalDecimals = d; }
    function setMockCapacityConfig(CapacityConfig calldata c) external { _capacityConfig = c; }

    function setOrderMarket(
        uint256 coverTokenId,
        bytes32 marketId,
        uint256 period,
        uint256 allocatedCoverAmount,
        address payoutRecipient
    ) external {
        _orderMarkets[coverTokenId][marketId] = OrderMarket(period, allocatedCoverAmount, payoutRecipient);
    }

    // -------------------------------------------------------------------------
    // Functions exercised by IncidentManager
    // -------------------------------------------------------------------------

    function CANONICAL_DECIMALS() external view override returns (uint8) { return _canonicalDecimals; }
    function vault() external view override returns (IFirelightVault) { return _vault; }

    function getCapacityConfigAt(uint256) external view override returns (CapacityConfig memory) {
        return _capacityConfig;
    }

    function getCoverOrderMarketInfo(
        uint256 coverTokenId,
        bytes32 marketId
    ) external view override returns (uint256 period, uint256 allocatedCoverAmount, address payoutRecipient) {
        OrderMarket storage m = _orderMarkets[coverTokenId][marketId];
        return (m.period, m.allocatedCoverAmount, m.payoutRecipient);
    }

    // -------------------------------------------------------------------------
    // Interface stubs (not used by IncidentManager)
    // -------------------------------------------------------------------------

    function createCoverOrder(
        address,
        address,
        string calldata,
        address,
        MarketAllocationInput[] calldata,
        CoverOrderType
    ) external pure override returns (uint256) {
        return 0;
    }

    function commitAllocation(uint256, bytes32, uint256) external pure override {}
    function setPriceFeedAdapter(IAggregatorV3) external pure override {}
    function setMaxPriceAge(uint48) external pure override {}
    function setSettlementGracePeriod(uint48) external pure override {}
    function priceFeedAdapter() external pure override returns (IAggregatorV3) { return IAggregatorV3(address(0)); }
    function maxPriceAge() external pure override returns (uint48) { return 0; }
    function settlementGracePeriod() external pure override returns (uint48) { return 0; }
    function priceFeedDecimals() external pure override returns (uint8) { return 0; }
    function settleCoverOrder(uint256, MarketCoverAllocation[] calldata, uint256, bytes32[] calldata) external pure override {}
    function batchSettleCoverOrder(SettleParams[] calldata) external pure override {}
    function cancelCoverOrder(uint256) external pure override {}
    function cancelExpiredOrders(uint256[] calldata) external pure override {}
    function recommitAllocation(uint256, bytes32, uint256) external pure override {}
    function cancelCommitAllocation(uint256) external pure override {}

    function setPremiumCollector(address) external pure override {}
    function addSupportedPremiumToken(address) external pure override {}
    function removeSupportedPremiumToken(address) external pure override {}
    function setCapacityConfig(CapacityConfig calldata) external pure override {}
    function addSupportedMarket(Market calldata) external pure override returns (bytes32) {
        return bytes32(0);
    }
    function setProtocolConcentration(ProtocolConcentrationInput calldata) external pure override {}
    function batchSetProtocolConcentration(ProtocolConcentrationInput[] calldata) external pure override {}

    function premiumCollector() external pure override returns (address) {
        return address(0);
    }
    function coverNFT() external pure override returns (CoverNFT) {
        return CoverNFT(address(0));
    }
    function nextCoverOrderId() external pure override returns (uint256) {
        return 0;
    }
    function getCoverOrder(uint256) external pure override returns (CoverOrder memory o) {
        return o;
    }
    function getCoverOrderMarkets(uint256) external pure override returns (MarketAllocation[] memory m) {
        return m;
    }
    function getCoverOrdersIdByPeriod(uint256) external pure override returns (uint256[] memory ids) {
        return ids;
    }
    function getSupportedMarket(bytes32) external pure override returns (Market memory m) {
        return m;
    }
    function getSupportedMarketIds() external pure override returns (bytes32[] memory ids) {
        return ids;
    }
    function isPremiumTokenSupported(address) external pure override returns (bool) {
        return false;
    }
    function getSupportedPremiumTokens() external pure override returns (address[] memory tokens) {
        return tokens;
    }
    function getEffectiveCapacityConfig() external view override returns (CapacityConfig memory) {
        return _capacityConfig;
    }
    function getAllocationCommitment(uint256) external pure override returns (AllocationCommitment memory c) {
        return c;
    }
    function getSupportedProtocolConcentrationHashes() external pure override returns (bytes32[] memory h) {
        return h;
    }
    function getProtocolConcentrationHash(uint64, string calldata) external pure override returns (bytes32) {
        return bytes32(0);
    }
    function getMarketId(uint64, string calldata, bytes32) external pure override returns (bytes32) {
        return bytes32(0);
    }
    function getProtocolConcentrationFromHash(bytes32) external pure override returns (ProtocolConcentration memory c) {
        return c;
    }
    function getEffectiveProtocolConcentration(bytes32) external pure override returns (uint256) {
        return 0;
    }
    function getProtocolConcentrationAt(bytes32, uint256) external pure override returns (uint256) {
        return 0;
    }
    function getProtocolConcentrationSettledCover(uint256, bytes32) external pure override returns (uint256) {
        return 0;
    }
}
