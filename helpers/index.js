import {
  DYDX_ABI,
  SIG_RELAYER_ABI,
  GOVERNOR_ABI,
  SIG_RELAYER_ADDRESS,
  DYDX_ADDRESS,
  GOVERNOR_ADDRESS,
} from "helpers/abi"; // Contract ABIs + Addresses
import {
  insertDelegateTx,
  insertVoteTx,
  delegationAllowed,
  voteAllowed,
  pendingTransactions,
  fetchProposals,
  addProposals,
  fetchCachedProposalsCount
} from "helpers/database/awaitingTxs"; // Database helper functions
import Web3 from "web3"; // Web3
import axios from "axios"; // Axios requests
import { recoverTypedSignature } from "@metamask/eth-sig-util";

/**
 * Instantiates server-side web3 connection
 */
const Web3Handler = () => {
  // Setup web3 handler
  const web3 = new Web3(process.env.NEXT_PUBLIC_INFURA_RPC);

  // Setup contracts
  const sigRelayer = new web3.eth.Contract(
    SIG_RELAYER_ABI,
    SIG_RELAYER_ADDRESS
  );
  const dydxToken = new web3.eth.Contract(DYDX_ABI, DYDX_ADDRESS);
  const governor = new web3.eth.Contract(GOVERNOR_ABI, GOVERNOR_ADDRESS);

  // Return web3 + contracts
  return {
    web3,
    sigRelayer,
    dydxToken,
    governor,
  };
};

/**
 * Generate voting message
 * @param {Number} id for dYdX Governance proposal
 * @param {boolean} support for or against
 */
const createVoteBySigMessage = (id, support) => {
  // Types
  const types = {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    VoteEmitted: [
      { name: "id", type: "uint256" },
      { name: "support", type: "bool" },
    ],
  };

  // Return message to sign
  return {
    types,
    primaryType: "VoteEmitted",
    domain: {
      name: "dYdX Governance",
      chainId: 1,
      verifyingContract: "0x7E9B1672616FF6D6629Ef2879419aaE79A9018D2",
    },
    message: {
      id,
      support,
    },
  };
};

/**
 * Generate delegation message
 * @param {string} delegatee address to delegate voting power to
 * @param {integer} nonce transaction nonce
 */
const createDelegateBySigMessage = (delegatee, nonce, expiry) => {
  // Types
  const types = {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    Delegate: [
      { name: "delegatee", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "expiry", type: "uint256" },
    ],
  };

  // Return message to sign
  return {
    types,
    primaryType: "Delegate",
    domain: {
      name: "dYdX",
      version: 1,
      chainId: 1,
      verifyingContract: "0x92D6C1e31e14520e676a687F0a93788B716BEff5",
    },
    // Message
    message: {
      // Delegatee address
      delegatee,
      nonce,
      expiry,
    },
  };
};

/**
 * Checks if address can delegate by sig to given delegatee
 * @param {String} address to delegate from
 * @param {String} delegatee address to delegate to (optional)
 */
const canDelegate = async (address, delegatee = "0x") => {
  // Collect COMP token contract
  const { web3, dydxToken } = Web3Handler();

  // Delegatee and address formatting
  delegatee = delegatee.toString().toLowerCase();
  address = address.toString().toLowerCase();

  // Check for address
  if (address === undefined) {
    const error = new Error("invalid address input");
    error.code = 422;
    throw error;
  }

  if (delegatee != "0x") {
    // Address set, must be valid
    if (!web3.utils.isAddress(delegatee)) {
      // Invalid address
      const newError = new Error("invalid delegatee address");
      newError.code = 422;
      throw newError;
    }
  }

  if (!web3.utils.isAddress(address)) {
    const newError = new Error("invalid from address");
    newError.code = 422;
    throw newError;
  }

  // Gets the address onchain dYdX balance, current address
  // delegated to and checks if database for delegationAllowed
  let dydxBalance, currentDelegateeVoting, currentDelegateeProposition;

  try {
    [dydxBalance, currentDelegateeVoting, currentDelegateeProposition] =
      await Promise.all([
        // Collect address COMP balance
        dydxToken.methods.balanceOf(address).call(),
        // Collect address delegated to for voting power
        dydxToken.methods.getDelegateeByType(address, 0).call(),
        // Collect address delegated to for proposition power
        dydxToken.methods.getDelegateeByType(address, 1).call(),
        // Collect database for delegationAllowed
        delegationAllowed(address),
      ]);
  } catch (error) {
    // If error from database
    if (typeof error.code == "number") {
      // Return error
      throw error;
    }

    // Else, return blockchain error
    const newError = new Error("error fetching data from blockchain");
    newError.code = 500;
    throw newError;
  }

  // Enforces a min dYdX balance
  if (parseInt(dydxBalance) < parseInt(process.env.MIN_COMP)) {
    const error = new Error("dYdX balance too low");
    error.code = 403;
    throw error;
  }

  // If delegatee is specified, must not match both existing delegatees
  if (
    delegatee != "0x" &&
    delegatee.localeCompare(currentDelegateeVoting.toString().toLowerCase()) ==
      0 &&
    delegatee.localeCompare(
      currentDelegateeProposition.toString().toLowerCase()
    ) == 0
  ) {
    const error = new Error("delegatee can not be current delegatee");
    error.code = 403;
    throw error;
  }
};

/**
 * Checks if an address can vote by sig for the given proposal
 * @param {String} address Voting address
 * @param {Number} proposalId Proposal to vote on
 */
const canVote = async (address, proposalId) => {
  // Collect Web3 + contracts
  const { web3, dydxToken, governor } = Web3Handler();

  // Check for undefined inputs
  if (typeof address == "undefined" || typeof proposalId == "undefined") {
    const error = new Error("invalid input");
    error.code = 422;
    throw error;
  }

  // Force address formatting
  address = address.toString().toLowerCase();

  if (!web3.utils.isAddress(address)) {
    const newError = new Error("invalid from address");
    newError.code = 422;
    throw newError;
  }

  // On chain proposal data
  let proposal;
  // On chain votes delegated at start of proposal
  let votesDelegated;
  // Address proposal receipt. Stores voting status
  let receipt;
  // Current chain block
  let currentBlock;

  try {
    [proposal, receipt, currentBlock] = await Promise.all([
      // Collect proposal data
      governor.methods.getProposalById(proposalId).call(),
      // Collect proposal receipt
      governorBravo.methods.getVoteOnProposal(proposalId, address).call(),
      // Collect current block number
      web3.eth.getBlockNumber(),
      // Check if vote is allowed from db
      voteAllowed(address, proposalId),
    ]);

    // Check prior delegated votes
    votesDelegated = await dydxToken.methods
      .getPowerAtBlock(address, proposal.startBlock, 0)
      .call();
  } catch (erorr) {
    // Error thrown from DB vote allowed. Throw to res
    if (typeof erorr.code == "number") {
      throw erorr;
    }

    // Else, throw blockchain error
    const newError = new Error("error fetching data from blockchain");
    newError.code = 500;
    throw newError;
  }

  // Not ongoing proposal. Leaves a 2400 block buffer for relaying
  if (
    !(
      currentBlock > proposal.startBlock &&
      currentBlock < proposal.endBlock - 2400
    ) ||
    proposal.canceled
  ) {
    const error = new Error("proposal voting period is not active");
    error.code = 400;
    throw error;
  }

  // Require at least min comp COMP delegated
  if (
    parseInt(votesDelegated) < parseInt(process.env.MIN_COMP) &&
    !isWhitelisted(address)
  ) {
    const error = new Error("dYdX voting power is too low");
    error.code = 403;
    throw error;
  }

  // Check address has not voted yet
  if (receipt.votingPower > 0) {
    const error = new Error("address already voted");
    error.code = 400;
    throw error;
  }
};

function isWhitelisted(address) {
  const whitelist = [
    "0x5b3bffc0bcf8d4caec873fdcf719f60725767c98",
    "0x2b384212edc04ae8bb41738d05ba20e33277bf33",
  ];
  return whitelist.includes(address);
}

/**
 * Validates the given vote by sig data and saves it to the database
 * @param {String} address that created the signature
 * @param {Number} proposalId to vote on
 * @param {bool} support
 * @param {String} v
 * @param {String} r
 * @param {String} s
 */
const vote = async (address, proposalId, support, v, r, s) => {
  // Check for undefined inputs
  if ([address, proposalId, support, v, r, s].includes(undefined)) {
    const error = new Error("invalid input");
    error.code = 422;
    throw error;
  }

  // Force address formatting
  address = address.toString().toLowerCase();

  const data = createVoteBySigMessage(proposalId, support);
  let sigAddress;
  try {
    sigAddress = await recoverTypedSignature({
      data,
      signature: r + s.substring(2) + v.substring(2),
      version: "V4",
    });
  } catch (err) {
    const newErr = new Error("invalid signature");
    newErr.code = 422;
    throw newErr;
  }

  // Force address formatting
  sigAddress = sigAddress.toString().toLowerCase();

  // Address verified to create sig and alleged must match
  if (address.localeCompare(sigAddress) != 0) {
    const error = new Error("invalid signature");
    error.code = 422;
    throw error;
  }

  try {
    await canVote(address, proposalId);
  } catch (error) {
    // Pass error from db
    if (typeof error.code == "number") {
      throw error;
    }

    // Else, send error from database
    const newError = new Error("error fetching data from blockchain");
    newError.code = 500;
    throw newError;
  }

  // Create new transactions
  const newTx = {
    from: address,
    v,
    r,
    s,
    support,
    proposalId,
    type: "vote",
    createdAt: new Date(),
    executed: false,
  };

  // Insert vote transaction to db
  await insertVoteTx(newTx);

  // Send notification to admin using telegram
  if (typeof process.env.NOTIFICATION_HOOK != "undefined") {
    await axios.get(process.env.NOTIFICATION_HOOK + "New dydx.vote voting sig");
  }
};

/**
 * Validates the given delegate by sig data and saves it to the database
 * @param {String} address that created the signature
 * @param {String} delegatee to delegate to
 * @param {Number} nonce
 * @param {Number} expiry UNIX time when signature expires
 * @param {String} v
 * @param {String} r
 * @param {String} s
 */
const delegate = async (address, delegatee, nonce, expiry, v, r, s) => {
  // Validate input data
  if ([address, delegatee, nonce, expiry, v, r, s].includes(undefined)) {
    const error = new Error("invalid input");
    error.code = 422;
    throw error;
  }

  // Force address formatting
  address = address.toString().toLowerCase();
  delegatee = delegatee.toString().toLowerCase();

  // Address verified used to create signature
  let sigAddress;
  const data = createDelegateBySigMessage(delegatee, nonce, expiry);

  try {
    sigAddress = await recoverTypedSignature({
      data: data,
      signature: r + s.substring(2) + v.substring(2),
      version: "V4",
    });
  } catch (err) {
    const newErr = new Error("invalid signature");
    newErr.code = 422;
    throw newErr;
  }

  // Force address formatting
  sigAddress = sigAddress.toString().toLowerCase();

  // Force address formatting
  sigAddress = sigAddress.toString().toLowerCase();

  // Address verified to create sig and alleged must match
  if (sigAddress.localeCompare(address) != 0) {
    const error = new Error("given address does not match signer address");
    error.code = 422;
    throw error;
  }

  try {
    await canDelegate(address, delegatee);
  } catch (error) {
    // Return error from db
    if (typeof error.code == "number") {
      throw error;
    }

    // Else, return blockchain error
    const newError = new Error("error fetching data from blockchain");
    newError.code = 500;
    throw newError;
  }

  // Create transaction
  const newTx = {
    from: address,
    delegatee,
    v,
    r,
    s,
    nonce,
    expiry,
    type: "delegate",
    createdAt: new Date(),
    executed: false,
  };

  // Insert transaction into db
  await insertDelegateTx(newTx);

  // Send notification to admin using telegram
  if (typeof process.env.NOTIFICATION_HOOK != "undefined") {
    await axios.get(
      process.env.NOTIFICATION_HOOK + "New dydx.vote delegation sig"
    );
  }
};

const getPendingTransactions = async () => {
  return await pendingTransactions();
};

// Export functions
export { canDelegate, canVote, vote, delegate, getPendingTransactions, fetchProposals, addProposals, fetchCachedProposalsCount };
