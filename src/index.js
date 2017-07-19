'use strict'

var http = require('http');

/* File management */
var fs = require('fs');

/* UUID generation */
var uuidv1 = require('uuid/v1');

/* Asynchron operations */
var async = require('async');

/* Logging library */
var log4js = require('log4js');

/** 
 * Get the default configuration from environment variables, 
 * if none present use default values
 */
var folioHost = process.env.FOLIO_HOST || 'localhost';
var folioPort = process.env.FOLIO_PORT || '9130';
var folioProtocol = process.env.FOLIO_PROTOCOL || 'http:';
var folioTenant = process.env.FOLIO_TENANT || 'diku';
var folioUsername = process.env.FOLIO_USERNAME || 'diku_admin';
var folioPassword = process.env.FOLIO_PASSWORD || 'admin';
var folioFilename = process.env.FOLIO_FILENAME || 'users.json';
var folioPageSize = process.env.FOLIO_PAGESIZE || '10';
var folioLogFile = process.env.FOLIO_LOGFILE || 'logs/user-import.log';
/* Available levels: TRACE, DEBUG, INFO, WARN, ERROR, FATAL */
var folioLogLevel = process.env.FOLIO_LOGLEVEL || 'DEBUG';

/* This variable will hold the authentication token */
var authToken = '';

/* This variable will hold the patron groups as a map (the key is the group name, the value is the id) */
var patronGroups = {};

/* This variable will hold the actually available address types (the key is the address type name, the value is the id) */
var addressTypes = {};

/* Preferred contact type names and codes */
var preferredContactTypes = {
  'mail': '001',
  'email': '002',
  'text': '003',
  'phone': '004',
  'mobile': '005'
}

var logger;

function initConfig(configUrl) {
  if (configUrl) {
    try {
      let config = require(configUrl);
      folioHost = config.FOLIO_HOST || folioHost;
      folioPort = config.FOLIO_PORT || folioPort;
      folioProtocol = config.FOLIO_PROTOCOL || folioProtocol;
      folioTenant = config.FOLIO_TENANT || folioTenant;
      folioUsername = config.FOLIO_USERNAME || folioUsername;
      folioPassword = config.FOLIO_PASSWORD || folioPassword;
      folioFilename = config.FOLIO_FILENAME || folioFilename;
      folioPageSize = config.FOLIO_PAGESIZE || folioPageSize;
      folioLogFile = config.FOLIO_LOGFILE || folioLogFile;
      folioLogLevel = config.FOLIO_LOGLEVEL || folioLogLevel;
    } catch (e) {
      logger.warn('Failed to load config file.', e.message);
    }
  }
  log4js.configure({
    appenders: [{
      type: 'file',
      filename: folioLogFile,
      category: 'user-import'
    }]
  });
  logger = log4js.getLogger('user-import');
  logger.setLevel(folioLogLevel);
}

/**
 * Starts import process with login.
 * Calls listing of address types.
 * 
 * @param configUrl - optional parameter, filename for user data
 */
function startImport(configUrl) {
  initConfig(configUrl);
  logger.trace('Config file name: ', configUrl);
  login()
}

function login() {
  let authOptions = {
    method: 'POST',
    protocol: folioProtocol,
    host: folioHost,
    port: folioPort,
    path: '/authn/login',
    headers: {
      'X-Okapi-Tenant': folioTenant,
      'Content-type': 'application/json',
      'Accept': 'application/json'
    }
  }

  let authCredentials = {
    'username': folioUsername,
    'password': folioPassword,
    'tenant': folioTenant
  };

  let json = JSON.stringify(authCredentials);

  /** Login to FOLIO and save token from response. */
  let req = http.request(authOptions, function (response) {
    let loginToken = response.headers['x-okapi-token'];
    if (!loginToken) {
      logger.error('Failed to log in to FOLIO. Exiting.');
      process.exit();
    }
    logger.trace('Logged in to FOLIO.');
    authToken = loginToken;
    getAddressTypes();
  }).on('error', (e) => {
    logger.error('Failed to request log in to FOLIO.', e.message);
    process.exit();
  });

  req.write(json);
  req.end();
}

/**
 * Read user data from (JSON) file and start processing.
 */
function readUserData() {
  fs.readFile(folioFilename, function (err, data) {
    if (err) {
      logger.error(err.stack);
      process.exit();
    }

    processUsers(data.toString());
  });
}

/**
 * Iterate over users and call searchusers for every {folioPageSize} user.
 * 
 * @param usersDataString - the conent of the users (JSON) file as a string
 */
function processUsers(usersDataString) {
  let data = JSON.parse(usersDataString);

  let userData = [];

  while (data.length) {
    userData.push(data.splice(0, folioPageSize));
  }

  async.eachLimit(userData, 1, searchUsers, function (err) {
    logger.info('ended.');
    if (err) {
      logger.error('async error: ', err);
    } else {
      logger.info('Imported all users.');
    }
  });

}

/**
 * Check if users exist in FOLIO.
 * 
 * @param userList - the user list limited to {folioPageSize}
 */
function searchUsers(userList, callback) {
  let queryPath = '(';
  for (let i = 0; i < userList.length; i++) {
    queryPath += 'externalSystemId=="' + userList[i].externalSystemId + '"';
    if (i < userList.length - 1) {
      queryPath += ' or ';
    } else {
      queryPath += ')';
    }
  }

  let searchOptions = createRequest('GET', '/users?query=' + encodeURIComponent(queryPath), 'application/json');

  http.get(searchOptions, function (response) {

    let rawData = '';
    response.on('data', (chunk) => {
      rawData += chunk;
    });
    response.on('end', () => {
      try {
        logger.debug('status: ', response.statusCode);
        if (response.status < 200 || response.status > 299) {
          callback(new Error('Failed to list existing users'));
        } else {
          const userSearchResult = JSON.parse(rawData);
          importUsers(userList, userSearchResult.users, callback);
        }
      } catch (e) {
        logger.error('Failed to list existing users', e.message);
        callback(e);
      }
    });
  }).on('error', (e) => {
    logger.error('Failed to search users.', e.message);
    callback(e);
  });
}

/**
 * Iterate on existing users and decide if actual user should be created or updated.
 * 
 * @param userList - list of users from the import data
 * @param existingUsers - list of existing users retrieved from the server
 */
function importUsers(userList, existingUsers, callback) {

  let userMap = userList.reduce(function (map, obj) {
    map[obj.externalSystemId] = obj;
    return map;
  }, {});

  existingUsers.forEach(function (user) {
    let userToUpdate = userMap[user.externalSystemId];
    if (userToUpdate) {
      userToUpdate.id = user.id;
    }
  });

  async.each(userMap, function (user, userCallback) {
    if (user.id) {
      updateUser(user, userCallback);
    } else {
      createUser(user, userCallback);
    }
  }, function (err, result) {
    if (err) {
      logger.info('Failed to import users', err);
      callback(err);
    } else {
      logger.info('Imported users.');
      callback();
    }
  });
}

/**
 * Update a specific user.
 * 
 * @param user - the user object, updated with the id retreived from the server.
 */
function updateUser(user, callback) {

  if (user.patronGroup) {
    user.patronGroup = patronGroups[user.patronGroup];
  }

  if (user.personal) {
    if (user.personal.preferredContactTypeId) {
      user.personal.preferredContactTypeId = preferredContactTypes[user.personal.preferredContactTypeId];
    }
    if (user.personal.addresses && user.personal.addresses.length > 0) {
      user.personal.addresses.forEach(function (address) {
        if (address.addressTypeId) {
          address.addressTypeId = addressTypes[address.addressTypeId];
        }
      });
    }
  }

  let updateOptions = createRequest('PUT', '/users/' + user.id, 'text/plain', 'application/json');

  let json = JSON.stringify(user);

  let req = http.request(updateOptions, function (response) {
    logger.info('User update status: ' + user.externalSystemId, response.statusCode);
    let userUpdateResult = '';
    response.on('data', (chunk) => {
      userUpdateResult += chunk;
    });
    response.on('end', () => {
      try {
        if (response.statusCode > 299 || response.statusCode < 200) {
          logger.warn('Failed to update user with externalSystemId: ' + user.externalSystemId, userUpdateResult);
          callback(new Error('Failed to update userwith externalSystemId: ' + user.externalSystemId));
        } else {
          callback();
        }
      } catch (e) {
        logger.error('Failed to update user with externalSystemId: ' + user.externalSystemId + ' Reason: ', e.message);
        callback(e);
      }
    });
  }).on('error', (e) => {
    logger.error('Failed to update user with externalSystemId: ' + user.externalSystemId, e.message);
    callback(e);
  });

  req.write(json);
  req.end();

}

/**
 * Create a new user.
 * 
 * @param user - the user object to create. If the user id is not specified, the id will be the externalSystemId for now.
 */
function createUser(user, callback) {
  user.id = uuidv1();

  if (user.patronGroup) {
    user.patronGroup = patronGroups[user.patronGroup];
  }

  if (user.personal) {
    if (user.personal.preferredContactTypeId) {
      user.personal.preferredContactTypeId = preferredContactTypes[user.personal.preferredContactTypeId];
    }
    if (user.personal.addresses && user.personal.addresses.length > 0) {
      user.personal.addresses.forEach(function (address) {
        if (address.addressTypeId) {
          address.addressTypeId = addressTypes[address.addressTypeId];
        }
      });
    }
  }

  let createOptions = createRequest('POST', '/users', 'text/plain', 'application/json');

  let json = JSON.stringify(user);

  let req = http.request(createOptions, function (response) {
    logger.info('User create status: ' + user.externalSystemId, response.statusCode);
    let userCreateResult = '';
    response.on('data', (chunk) => {
      userCreateResult += chunk;
    });
    response.on('end', () => {
      try {
        if (response.statusCode > 299 || response.statusCode < 200) {
          logger.warn('Failed to create user with externalSystemId: ' + user.externalSystemId, userCreateResult);
          callback(new Error('Failed to create user with externalSystemId: ' + user.externalSystemId));
        } else {
          createCredentials(user, callback);
        }
      } catch (e) {
        logger.error(e.message);
        callback(e);
      }
    });
  }).on('error', (e) => {
    logger.error('Failed to create user with externalSystemId: ' + user.externalSystemId, e.message);
    callback(e);
  });

  req.write(json);
  req.end();
}

/**
 * Add username + empty password for user.
 * 
 * @param user - the saved user - only the username will be used for now
 */
function createCredentials(user, callback) {
  let credentialOptions = createRequest('POST', '/authn/credentials', 'text/plain', 'application/json');

  let json = JSON.stringify({
    'username': user.username,
    'password': ''
  });

  let req = http.request(credentialOptions, function (response) {
    logger.info('User credentials creation status: ' + user.username, response.statusCode);
    let userCreateResult = '';
    response.on('data', (chunk) => {
      userCreateResult += chunk;
    });
    response.on('end', () => {
      try {
        if (response.statusCode > 299 || response.statusCode < 200) {
          logger.warn('Failed to create user credentials for user with name: ' + user.username, userCreateResult);
          callback(new Error('Failed to create user credentials for user with name: ' + user.username));
        } else {
          applyEmptyPermissionSet(user, callback);
        }
      } catch (e) {
        logger.error('Failed to save credentials for user with name: ' + user.username + ' Reason: ', e.message);
        callback(e);
      }
    });
  }).on('error', (e) => {
    logger.error('Failed to add user credentials for user: ' + user.username, e.message);
    callback(e);
  });

  req.write(json);
  req.end();

}

/**
 * Get patron group list and create a name-id map.
 * Start user data processing.
 */
function getPatronGroups() {
  let patronGroupRequest = createRequest('GET', '/groups', 'application/json');

  let req = http.get(patronGroupRequest, function (response) {
    logger.info('Patron group list request status: ', response.statusCode);
    let groupResult = '';
    response.on('data', (chunk) => {
      groupResult += chunk;
    });
    response.on('end', () => {
      try {
        if (response.statusCode > 299 || response.statusCode < 200) {
          logger.warn('Failed to list patron groups.', groupResult);
        } else {
          var groupList = JSON.parse(groupResult);
          groupList.usergroups.forEach(function (group) {
            patronGroups[group.group] = group.id;
          });
        }
      } catch (e) {
        logger.error('Failed to retrieve patron groups. Reason: ', e.message);
      }
      readUserData();
    });
  }).on('error', (e) => {
    logger.error('Failed to list parton groups.', e.message);
  });

}

/**
 * Get list of address types existing in the system.
 * Trigger retrieving patron groups.
 */
function getAddressTypes() {

  let addressTypeRequest = createRequest('GET', '/addresstypes', 'application/json');

  let req = http.get(addressTypeRequest, function (response) {
    logger.info('Address type list request status: ', response.statusCode);
    let addressResult = '';
    response.on('data', (chunk) => {
      addressResult += chunk;
    });
    response.on('end', () => {
      try {
        if (response.statusCode > 299 || response.statusCode < 200) {
          logger.warn('Failed to list address types.', addressResult);
        } else {
          let addressTypeList = JSON.parse(addressResult).addressTypes;
          addressTypeList.forEach(function (addressType) {
            addressTypes[addressType.addressType] = addressType.id;
          });
          logger.trace('Address types are: ', addressTypes);
        }
      } catch (e) {
        logger.error('Failed to get address type list. Reason: ', e.message);
      }
      getPatronGroups();
    });
  }).on('error', (e) => {
    logger.error('Failed to list address types.', e.message);
  });

}

function applyEmptyPermissionSet(user, callback) {
  let createPermissions = createRequest('POST', '/perms/users', 'text/plain', 'application/json');

  let json = JSON.stringify({
    'username': user.username,
    'permissions': []
  });

  let req = http.request(createPermissions, function (response) {
    logger.info('User permissions creation status: ' + user.username, response.statusCode);
    let userCreateResult = '';
    response.on('data', (chunk) => {
      userCreateResult += chunk;
    });
    response.on('end', () => {
      try {
        if (response.statusCode > 299 || response.statusCode < 200) {
          logger.warn('Failed to create user permissions for user with name: ' + user.username, userCreateResult);
          callback(new Error('Failed to create user permissions for user with name: ' + user.username));
        } else {
          callback();
        }
      } catch (e) {
        logger.error(e.message);
        callback(e);
      }
    });
  });

  req.write(json);
  req.end();
}

function createRequest(method, path, accept, contenttype) {
  var request = {
    method: method,
    protocol: folioProtocol,
    host: folioHost,
    port: folioPort,
    path: path,
    headers: {
      'X-Okapi-Tenant': folioTenant,
      'Accept': accept,
      'x-okapi-token': authToken
    }
  }
  if (contenttype) {
    request.headers['Content-type'] = contenttype;
  }
  return request;
}

module.exports = function (configUrl) {
  return startImport(configUrl);
}