# Firelight Core

Smart contracts for the Firelight protocol.

The core contracts include:

- `FirelightVault`: ERC-4626 compatible vault with period accounting, payout, withdrawal, pause, and blocklist controls.
- `CoverNFT`: ERC-721 cover position token used by the cover allocation system.
- `CoverOrderAllocator`: cover order, settlement, premium, and market allocation logic.
- `IncidentManager`: incident creation, assessment, approval, and payout orchestration.
- `VaultRewardDistributor`: distribution helper for vault-related rewards.
- `FtsoChainlinkAdapter`: oracle adapter exposing Flare FTSO prices through a Chainlink-compatible interface.

## Install

```bash
npm install
```

## Compile

```bash
npm run compile
```

## Test

```bash
npm test
```

## License

BUSL-1.1
