// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {IncidentManager} from "../core/IncidentManager.sol";

/**
 * @dev Exposes IncidentManager internal functions so tests can exercise defensive
 *      branches unreachable through the external ABI (e.g. `_decreaseIncident` with
 *      a zero active-incident count).
 */
contract IncidentManagerHarness is IncidentManager {
    function exposedDecreaseIncident(uint256 period) external {
        _decreaseIncident(period);
    }
}
