// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IAggregatorV3} from "../interfaces/IAggregatorV3.sol";

/**
 * @title PriceFeed
 * @notice Reads and validates a Chainlink-compatible price feed answer.
 * @custom:security-contact securityreport@firelight.finance
 */
library PriceFeed {
    /// @notice Thrown when the feed returns a non-positive answer.
    /// @param price The non-positive answer returned by the feed.
    error InvalidAssetPrice(int256 price);
    /// @notice Thrown when the feed reports a zero `updatedAt` timestamp.
    error InvalidAssetPriceUpdatedAt();
    /// @notice Thrown when the feed answer is older than the allowed maximum age.
    /// @param updatedAt Timestamp of the feed answer.
    /// @param maxPriceAge Maximum tolerated age, in seconds.
    error PriceFeedTooOld(uint256 updatedAt, uint48 maxPriceAge);
    /// @notice Thrown when the answered round is older than the requested round.
    /// @param roundId Round id of the latest answer.
    /// @param answeredInRound Round in which the answer was computed.
    error StaleAssetPriceRound(uint80 roundId, uint80 answeredInRound);

    /// @notice Reads `latestRoundData` and validates positivity, round, and freshness.
    /// @param feedAdapter Chainlink-compatible feed to query.
    /// @param maxAge Maximum tolerated age of the answer, in seconds.
    /// @return price The validated price, in the feed's own decimals.
    function getPrice(
        IAggregatorV3 feedAdapter,
        uint48 maxAge
    ) internal view returns (uint256 price) {
        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) = feedAdapter.latestRoundData();

        if (answer <= 0) revert InvalidAssetPrice(answer);
        if (updatedAt == 0) revert InvalidAssetPriceUpdatedAt();
        if (answeredInRound < roundId) revert StaleAssetPriceRound(roundId, answeredInRound);
        if (block.timestamp - updatedAt > maxAge) revert PriceFeedTooOld(updatedAt, maxAge);

        return (uint256(answer));
    }
}
