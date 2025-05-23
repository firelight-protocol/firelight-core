# Firelight
**Firelight** is a modular re-staking protocol built on **Flare**, using an ERC-4626-compliant vault for DeFi integration.

## Implementation
The protocol will be implemented in multiple phases, each adding new capabilities and expanding its reach across the Flare ecosystem.

 
### Phase One
The initial launch introduces the `FirelightVault`, an upgradeable smart contract that accepts **FXRP** deposits. In return, users receive **stXRP**, an ERC-20 token representing their share of the vault, usable across DeFi.

**Main features:**
- ERC-4626 upgradeable vault
- Role-based controls: `MINTER_ROLE`, `BURNER_ROLE`, `BLACKLIST_ROLE`
- Time-locked withdrawals with future slashing support

### Future Phases
Future releases will expand Firelight to support:
- Operators and network coordination
- Slashing mechanics
- Additional ERC-20 tokens and cross-chain staking

The `FirelightVault` deployed in Phase One is designed with these extensions in mind, providing a foundation for the protocol’s future architecture.


## Installation
```
git clone https://repo-url/firelight-core.git
cd firelight-core
npm install
```

## Testing
```
npx hardhat test
```