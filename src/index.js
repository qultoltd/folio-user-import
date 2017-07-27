'use strict'

/* HTTP requests */
var http = require('http');

/* File management */
var fs = require('fs');

/* UUID generation */
var uuid = require('uuid/v4');

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
/* Available log levels: TRACE, DEBUG, INFO, WARN, ERROR, FATAL */
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
var userCount = 0;

const keepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 10, keepAliveMsecs: 2000 });

/**
 * Calls config initialization and starts import process with login.
 * 
 * @param configUrl - optional parameter, filename for user data
 */
function startImport(configUrl) {
  initConfig(configUrl);
  try {
    login(function() {
      getAddressTypes(function() {
        getPatronGroups(function() {
          readUserData(function(userData) {
            processUsers(userData);
          });
        });
      });
    });
  } catch(e) {
    logger.error('Unhandled error.', e.message);
    keepAliveAgent.destroy();
  }
}

/* Initializes configuration from config file */
function initConfig(configUrl) {
  var configError;
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
      //Logger is not yet configured here.
      configError = e;
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
  logger.trace('Configuration has been initialized.');
  if(configError) {
    logger.warn('Error while processing config: ', e.message);
  }
}

/**
 * Tries to log in to FOLIO with configured credentials.
 * After login it calls the {getAddressTypes} function.
 * 
 * Process exits on failed login attempt.
 */
function login(callback) {
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
    },
    agent: keepAliveAgent
  }

  /** Login to FOLIO and save token from response. */
  let req = http.request(authOptions, function (response) {
    let loginToken = response.headers['x-okapi-token'];
    if (!loginToken) {
      logger.error('Failed to log in to FOLIO. Exiting.');
      keepAliveAgent.destroy();
    } else {    
      authToken = loginToken;
      logger.debug('Login was successful. Saved login token.');
      callback();
    }
  }).on('error', (e) => {
    logger.error('Failed to request log in to FOLIO.', e.message);
    keepAliveAgent.destroy();
  });

  req.end(JSON.stringify({
    'username': folioUsername,
    'password': folioPassword,
    'tenant': folioTenant
  }));
}

/**
 * Get list of address types existing in the system.
 * Trigger retrieving patron groups even if address types could not be processed.
 */
function getAddressTypes(callback) {

  let addressTypeRequest = createRequest('GET', '/addresstypes', 'application/json');

  let req = http.get(addressTypeRequest, function (response) {
    let addressResult = '';
    response.on('data', (chunk) => {
      addressResult += chunk;
    });
    response.on('end', () => {
      try {
        switch(response.statusCode) {
          case 200: {
            let addressTypeList = JSON.parse(addressResult).addressTypes;
            addressTypeList.forEach(function (addressType) {
              addressTypes[addressType.addressType] = addressType.id;
            });
            logger.debug('Listed address types successfully.');
            callback();
            break;
          }
          case 401: {
            logger.error('User is unauthorized. Exiting.', addressResult);
            keepAliveAgent.destroy();
          }
          case 500: {
            logger.error('Internal server error. Exiting.', addressResult);
            keepAliveAgent.destroy();
          }
          default: {
            logger.warn('Failed to list address types.', addressResult);
            callback();
            break;
          }
        }
      } catch (e) {
        logger.error('Failed to get address type list. Reason: ', e.message);
        callback();
      }
    });
  }).on('error', (e) => {
    logger.error('Failed to list address types.', e.message);
  });
}

/**
 * Get patron group list and create a name-id map.
 * Triggers user data processing even if patron groups could not be processed.
 */
function getPatronGroups(callback) {
  let patronGroupRequest = createRequest('GET', '/groups', 'application/json');

  let req = http.get(patronGroupRequest, function (response) {
    let groupResult = '';
    response.on('data', (chunk) => {
      groupResult += chunk;
    });
    response.on('end', () => {
      try {
        switch(response.statusCode) {
          case 200: {
            var groupList = JSON.parse(groupResult);
            groupList.usergroups.forEach(function (group) {
              patronGroups[group.group] = group.id;
            });
            logger.trace('Listed patron groups successfully.');
            callback();
            break;
          }
          case 401: {
            logger.error('User is unauthorized. Exiting.', groupResult);
            keepAliveAgent.destroy();
          }
          case 500: {
            logger.error('Internal server error. Exiting.', groupResult);
            keepAliveAgent.destroy();
          }
          default: {
            logger.warn('Failed to list patron groups.', groupResult);
            callback();
            break;
          }
        }
      } catch (e) {
        logger.error('Failed to retrieve patron groups. Reason: ', e.message);
        callback();
      }
    });
  }).on('error', (e) => {
    logger.error('Failed to list parton groups.', e.message);
  });
}

/**
 * Read user data from (JSON) file and triggers processing.
 * 
 * Process exits if the file can not be read.
 */
function readUserData(callback) {
  fs.readFile(folioFilename, function (err, data) {
    if (err || !data) {
      logger.error('Failed to read user data.', err.stack);
      keepAliveAgent.destroy();
    } else {
      callback(data.toString());
    }
  });
}

/**
 * Iterate over users and call searchusers for every {folioPageSize} user.
 * 
 * @param usersDataString - the conent of the users (JSON) file as a string
 * 
 * Process exits if the user data can not be parsed as a JSON list.
 */
function processUsers(usersDataString) {
  let userData = [];
  try {
    let data = JSON.parse(usersDataString);
    while (data.length) {
      userData.push(data.splice(0, folioPageSize));
    }

    async.each(userData, searchUsers, function (err) {
      if (err) {
        logger.error('Failed to import all users.', err);
        keepAliveAgent.destroy();
      } else {
        logger.info('Import has finished. See log for failed users.');
        keepAliveAgent.destroy();
      }
    });

  } catch (e) {
    logger.error('Failed to parse user data as JSON.', e.message);
    keepAliveAgent.destroy();
  }
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
        switch(response.statusCode) {
          case 200: {
            const userSearchResult = JSON.parse(rawData);
            importUsers(userList, userSearchResult.users, callback);
            break;
          }
          case 401: {
            logger.error('User is unauthorized.', rawData);
            callback(new Error(rawData));
            break;
          }
          case 403: {
            logger.error('Current user is not allowed to list users.', rawData);
            callback(new Error(rawData));
            break;
          }
          case 500: {
            logger.error('Internal server error.', rawData);
            callback(new Error(rawData));
            break;
          }
          default: {
            logger.warn('Failed to list existing users ', rawData);
            callback(new Error('Failed to list existing users with query: ' + queryPath));
            break;
          }
        }
      } catch (e) {
        logger.error('Failed to list and import existing users with query: ' + queryPath, e.message);
        callback(e);
      }
    });
  }).on('error', (e) => {
    logger.error('Failed to list existing users with query: ' + queryPath, e.message);
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
  logger.trace('Updated existing users with ids.');

  async.each(userMap, function (user, userCallback) {
    if (user.id) {
      updateUser(user, userCallback);
    } else {
      createUser(user, userCallback);
    }
  }, function (err) {
    if (err) {
      logger.info('Failed to import user batch.', err);
      callback(err);
    } else {
      logger.debug('Imported user batch successfully.');
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

  user = mapUserData(user);

  let updateOptions = createRequest('PUT', '/users/' + user.id, 'text/plain', 'application/json');

  let req = http.request(updateOptions, function (response) {
    logger.info('User update status: ' + user.externalSystemId, response.statusCode);
    let userUpdateResult = '';
    response.on('data', (chunk) => {
      userUpdateResult += chunk;
    });
    response.on('end', () => {
      try {
        switch(response.statusCode) {
          case 204: {
            logger.info('user update: ', userCount++);
            callback();
            break;
          }
          case 401: {
            logger.error('User is unauthorized.', userUpdateResult);
            callback(new Error(userUpdateResult));
            break;
          }
          case 403: {
            logger.error('Current user is not allowed to update a user.', userUpdateResult);
            callback(new Error(userUpdateResult));
            break;
          }
          case 500: {
            logger.error('Internal server error.', userUpdateResult);
            callback(new Error(userUpdateResult));
            break;
          }
          default: {
            logger.warn('Failed to update user with externalSystemId: ' + user.externalSystemId, userUpdateResult);
            logger.debug('User data: ', user);
            //callback(new Error('Failed to update user with externalSystemId: ' + user.externalSystemId));
            // This way if one user save fails it won't affect the creation/update of the other users.
            callback();
            break;
          }
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

  req.end(JSON.stringify(user));

}

/**
 * Create a new user.
 * 
 * @param user - the user object to create. If the user id is not specified, the id will be the externalSystemId for now.
 */
function createUser(user, callback) {
  user.id = uuid();

  user = mapUserData(user);

  let createOptions = createRequest('POST', '/users', 'text/plain', 'application/json');

  let req = http.request(createOptions, function (response) {
    logger.info('User create status: ' + user.externalSystemId, response.statusCode);
    let userCreateResult = '';
    response.on('data', (chunk) => {
      userCreateResult += chunk;
    });
    response.on('end', () => {
      try {
        switch(response.statusCode) {
          case 201: {
            logger.debug('Created user successfully. Creating credentials.');
            logger.info('user save: ', userCount++);
            applyEmptyPermissionSet(user, callback);
            break;
          }
          case 401: {
            logger.error('User is unauthorized.', userCreateResult);
            callback(new Error(userCreateResult));
            break;
          }
          case 403: {
            logger.error('User is not allowed to create a new user.', userCreateResult);
            callback(new Error(userCreateResult));
            break;
          }
          case 500: {
            logger.error('Internal server error.', userCreateResult);
            callback(new Error(userCreateResult));
            break;
          }
          default: {
            logger.warn('Failed to create user with externalSystemId: ' + user.externalSystemId, userCreateResult);
            //callback(new Error('Failed to create user with externalSystemId: ' + user.externalSystemId));
            // Do not let the whole batch fail because of one user save failure.
            callback();
            break;
          }
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

  req.end(JSON.stringify(user));
}

function applyEmptyPermissionSet(user, callback) {
  let createPermissions = createRequest('POST', '/perms/users', 'text/plain', 'application/json');

  let req = http.request(createPermissions, function (response) {
    logger.info('User permissions creation status: ' + user.username, response.statusCode);
    let permissionCreateResult = '';
    response.on('data', (chunk) => {
      permissionCreateResult += chunk;
    });
    response.on('end', () => {
      try {
        switch(response.statusCode) {
          case 201: {
            logger.debug('Permissions added successfully.');
            callback();
            break;
          }
          case 500: {
            logger.error('Internal server error.', permissionCreateResult);
            callback(new Error(permissionCreateResult));
            break;
          }
          default: {
            logger.warn('Failed to create user permissions for user with name: ' + user.username, permissionCreateResult);
            //callback(new Error('Failed to create user permissions for user with name: ' + user.username));
            callback();
            break;
          }
        }
      } catch (e) {
        logger.error(e.message);
        callback(e);
      }
    });
  });

  req.end(JSON.stringify({
    'username': user.username,
    'permissions': []
  }));
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
    },
    agent: keepAliveAgent
  }
  if (contenttype) {
    request.headers['Content-type'] = contenttype;
  }
  return request;
}

function mapUserData(user) {
  
  if (user.patronGroup) {
    if(patronGroups[user.patronGroup]) {
      user.patronGroup = patronGroups[user.patronGroup];
    } else {
      delete user.patronGroup;
    }
  }

  if (user.personal) {
    if (user.personal.preferredContactTypeId) {
      if(preferredContactTypes[user.personal.preferredContactTypeId]) {
        user.personal.preferredContactTypeId = preferredContactTypes[user.personal.preferredContactTypeId];
      } else {
        delete user.personal.preferredContactTypeId;
      }
    }
    if (user.personal.addresses && user.personal.addresses.length > 0) {
      let addresses = [];
      user.personal.addresses.forEach(function (address) {
        if (address.addressTypeId) {
          if(addressTypes[address.addressTypeId]) {
            address.addressTypeId = addressTypes[address.addressTypeId];
            addresses.push(address);
          } else {
            logger.warn('Address does not have valid address type which is mandatory. Skipping.');
          }
        }
      });
      user.personal.addresses = addresses;
    }
  }

  return user;
}

module.exports = function (configUrl) {
  return startImport(configUrl);
};