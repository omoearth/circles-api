import httpStatus from 'http-status';
import { Op } from 'sequelize';

import APIError from '../helpers/errors';
import User from '../models/users';
import core from '../services/core';
import web3 from '../services/web3';
import { respondWithSuccess } from '../helpers/responses';

const UNSET_NONCE = 0;

function prepareUserResult(response) {
  return {
    id: response.id,
    username: response.username,
    safeAddress: response.safeAddress,
    avatarUrl: response.avatarUrl,
  };
}

function checkSignature(address, nonce, signature, data) {
  const { safeAddress, username } = data;
  const dataString = [address, nonce, safeAddress, username].join('');

  let recoveredAddress;
  try {
    recoveredAddress = web3.eth.accounts.recover(dataString, signature);
  } catch {
    // Do nothing ..
  }

  if (recoveredAddress !== address) {
    throw new APIError(httpStatus.FORBIDDEN, 'Invalid signature');
  }
}

async function checkSafeStatus(isNonceGiven, safeAddress) {
  const { txHash } = await core.utils.requestRelayer({
    path: ['safes', safeAddress, 'funded'],
    method: 'GET',
    version: 2,
  });

  const isCreated = txHash !== null;

  if ((!isNonceGiven && !isCreated) || (isNonceGiven && isCreated)) {
    throw new APIError(httpStatus.BAD_REQUEST, 'Invalid Safe state');
  }
}

async function checkOwner(address, safeAddress) {
  const response = await core.utils.requestRelayer({
    path: ['safes', safeAddress],
    method: 'GET',
    version: 1,
  });

  if (!response.owners.includes(address)) {
    throw new APIError(httpStatus.BAD_REQUEST, 'Invalid Safe owner');
  }
}

async function checkSaltNonce(saltNonce, address, safeAddress) {
  const predictedSafeAddress = await core.safe.predictAddress(
    {
      address,
      // Fake private key to work around core validation
      privateKey: web3.utils.randomHex(64),
    },
    {
      nonce: saltNonce,
      owners: [address],
      threshold: 1,
    },
  );

  if (predictedSafeAddress !== safeAddress) {
    throw new APIError(httpStatus.BAD_REQUEST, 'Invalid nonce');
  }
}

async function checkIfExists(username, safeAddress) {
  const response = await User.findOne({
    where: safeAddress
      ? {
          [Op.or]: [
            {
              username,
            },
            {
              safeAddress,
            },
          ],
        }
      : {
          username,
        },
  });

  if (response) {
    throw new APIError(httpStatus.CONFLICT, 'Entry already exists');
  }
}

async function resolveBatch(req, res, next) {
  const { username, address } = req.query;

  User.findAll({
    where: {
      [Op.or]: [
        {
          username: {
            [Op.in]: username || [],
          },
        },
        {
          safeAddress: {
            [Op.in]: address || [],
          },
        },
      ],
    },
  })
    .then((response) => {
      respondWithSuccess(res, response.map(prepareUserResult));
    })
    .catch((err) => {
      next(err);
    });
}

async function findByUsername(req, res, next) {
  const { query } = req.query;

  User.findAll({
    where: {
      username: {
        [Op.iLike]: `%${query}%`,
      },
    },
    order: [['username', 'ASC']],
    limit: 10,
  })
    .then((response) => {
      respondWithSuccess(res, response.map(prepareUserResult));
    })
    .catch((err) => {
      next(err);
    });
}

export default {
  dryRunCreateNewUser: async (req, res, next) => {
    const { username } = req.body;

    if (username) {
      // Check if entry already exists
      try {
        await checkIfExists(username);
      } catch (err) {
        return next(err);
      }
    }

    respondWithSuccess(res, null, httpStatus.OK);
  },

  createNewUser: async (req, res, next) => {
    const { address, nonce = UNSET_NONCE, signature, data } = req.body;
    const { safeAddress, username, email, avatarUrl } = data;
    const isNonceGiven = nonce !== UNSET_NONCE;

    try {
      // Check signature
      checkSignature(address, nonce, signature, data);

      // Check if entry already exists
      await checkIfExists(username, safeAddress);

      // Check if claimed safe is correct and owned by address
      await checkSafeStatus(isNonceGiven, safeAddress);
      if (isNonceGiven) {
        await checkSaltNonce(nonce, address, safeAddress);
      } else {
        await checkOwner(address, safeAddress);
      }
    } catch (err) {
      return next(err);
    }

    // Everything is fine, create entry!
    User.create({
      avatarUrl,
      email,
      safeAddress,
      username,
    })
      .then(() => {
        respondWithSuccess(res, null, httpStatus.CREATED);
      })
      .catch((err) => {
        next(err);
      });
  },

  getByUsername: async (req, res, next) => {
    const { username } = req.params;

    User.findOne({
      where: {
        username,
      },
    })
      .then((response) => {
        if (response) {
          respondWithSuccess(res, prepareUserResult(response));
        } else {
          next(new APIError(httpStatus.NOT_FOUND));
        }
      })
      .catch((err) => {
        next(err);
      });
  },

  findUsers: async (req, res, next) => {
    if (req.query.query) {
      return await findByUsername(req, res, next);
    }

    return await resolveBatch(req, res, next);
  },
};
