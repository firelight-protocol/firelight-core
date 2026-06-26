// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title IAggregatorV3
 * @dev Chainlink Aggregator V3 interface for price feeds. Mirrors
 *      https://github.com/smartcontractkit/chainlink/blob/contracts-v1.3.0/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol
 */
interface IAggregatorV3 {
    /**
     * @notice Number of decimals for the price value.
     * @return The decimals.
     */
    function decimals() external view returns (uint8);

    /**
     * @notice Human-readable asset pair description (e.g., "ETH/USD").
     * @return The asset pair description.
     */
    function description() external view returns (string memory);

    /**
     * @notice Contract version.
     * @return Version as a uint256 value.
     */
    function version() external view returns (uint256);

    /**
     * @notice Obtain round data. Used for historical information, each round corresponds to a data point.
     * @dev Implementations that do not retain historical rounds (e.g. live FTSO-backed
     *      aggregators) should revert with a `NotImplemented()` custom error.
     */
    function getRoundData(uint80 _roundId)
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );

    /**
     * @notice Fetch the latest round information. Retrieves the last recorded data.
     */
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}

