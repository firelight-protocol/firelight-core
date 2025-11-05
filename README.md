# Firelight
**FirelightVault** is an upgradeable ERC‑4626 compatible vault with additional features:

- Total deposit limit
- Pause functionality
- Block and unblock accounts from moving shares
- Rescue shares or pending withdrawals from blocked accounts
- Time-locked withdrawals
- Historical tracking 
- Role-based controls: `DEPOSIT_LIMIT_UPDATE_ROLE`, `RESCUER_ROLE`, `BLOCKLIST_ROLE`, `PAUSE_ROLE` , `PERIOD_CONFIGURATION_UPDATE_ROLE`


## Installation
```
git clone https://github.com/firelight-protocol/firelight-core.git
cd firelight-core
npm install
```

## Env variables
Create your .env file using .env.sample as a guide. 


## Testing
```
npx hardhat test
```
