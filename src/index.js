'use strict'

var http = require('http');

/** File management */
var fs = require('fs');

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
var folioPageSize = process.env.FOLIO_PAGESIZE ||  '10';
var folioLogFile = process.env.FOLIO_LOGFILE || 'logs/user-import.log';

/** This variable will hold the authentication token */
var authToken = '';

/** This variable will hold the patron groups as a map (the key is the group name, the value is the id) */
var patronGroups = {};
/** This variable will hold the actually available address types (the key is the address type name, the value is the id) */
var addressTypes = {};

/** Preferred contact type names and codes */
var preferredContactTypes = {
    'mail': '001',
    'email':'002',
    'text': '003',
    'phone': '004',
    'mobile': '005'
}

/** Logging library */
var log4js = require('log4js');
log4js.configure({
  appenders: [
    { type: 'file', filename: folioLogFile, category: 'user-import' }
  ]
});
var logger = log4js.getLogger('user-import');
/** Available levels: TRACE, DEBUG, INFO, WARN, ERROR, FATAL */
logger.setLevel('DEBUG');

function initConfig(configUrl) {
    if(configUrl !== undefined) {
        try {
            var config = require(configUrl);
            folioHost = config.FOLIO_HOST || folioHost;
            folioPort = config.FOLIO_PORT || folioPort;
            folioProtocol = config.FOLIO_PROTOCOL || folioProtocol;
            folioTenant = config.FOLIO_TENANT || folioTenant;
            folioUsername = config.FOLIO_USERNAME || folioUsername;
            folioPassword = config.FOLIO_PASSWORD || folioPassword;
            folioFilename = config.FOLIO_FILENAME || folioFilename;
            folioPageSize = config.FOLIO_PAGESIZE || folioPageSize;
            folioLogFile = config.FOLIO_LOGFILE || folioLogFile;
        } catch (e) {
            logger.warn('Failed to load config file.', e.message);
        }
    }
}

/**
 * Starts import process with login.
 * Calls listing of address types.
 * 
 * @param configUrl - optional parameter, filename for user data
 */
function startImport(configUrl) {
    logger.trace('Config file name: ', configUrl);
    initConfig(configUrl);
    var authOptions = {
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

    var authCredentials = {
        'username': folioUsername,
        'password': folioPassword,
        'tenant': folioTenant
    };

    var json = JSON.stringify(authCredentials);

    /** Login to FOLIO and save token from response. */
    var req = http.request(authOptions, function(response) {
        var loginToken = response.headers['x-okapi-token'];
        if(loginToken === undefined) {
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
        if(err) {
            logger.error(err.stack);
            process.exit();
        }
        logger.trace('User data: ', data.toString());

        processUsers(data.toString());
    });
}

/**
 * Iterate over users and call searchusers for every {folioPageSize} user.
 * 
 * @param usersDataString - the conent of the users (JSON) file as a string
 */
function processUsers(usersDataString) {
    var data = JSON.parse(usersDataString);
    var tempUserMap = {};
    
    data.forEach(function(user) {
       logger.debug('User object: ', user);
       tempUserMap[user.username] = user;
       if(Object.keys(tempUserMap).length == Number(folioPageSize)) {
            searchUsers(tempUserMap);
            tempUserMap = {};
       }
    });
    if(Object.keys(tempUserMap).length > 0) {
        searchUsers(tempUserMap);
    }

}

/**
 * Check if users exist in FOLIO.
 * 
 * @param userMap - the user objects with the username as key
 */
function searchUsers(userMap) {
    var queryPath = '/users?query=(';
    var usernames = Object.keys(userMap);
    for(var i = 0; i < usernames.length; i++) {
        queryPath += 'username=%22' + usernames[i] + '%22';
        if(i < usernames.length -1 ) {
            queryPath += '%20or%20';
        } else {
            queryPath += ')';
        }
    }
    logger.debug('query path: ', queryPath);

    var searchOptions = {
        method: 'GET',
        protocol: folioProtocol,
        host: folioHost,
        port: folioPort,
        path: queryPath,
        headers: {
            'X-Okapi-Tenant': folioTenant,
            'Content-type': 'application/json',
            'Accept': 'application/json',
            'x-okapi-token': authToken
        }
    }

    http.get(searchOptions, function(response) {

        let rawData = '';
        response.on('data', (chunk) => { rawData += chunk; });
        response.on('end', () => {
            try {
                const userSearchResult = JSON.parse(rawData);
                logger.trace('Result of user pre check: ', userSearchResult);
                importUsers(userMap, userSearchResult.users);
            } catch (e) {
                logger.error('Failed to list ', e.message);
            }
        });
    }).on('error', (e) => {
        logger.error('Failed to search users.', e.message);
    });

}

/**
 * Iterate on existing users and decide if actual user should be created or updated.
 * 
 * @param userMap - map of users with username as key
 * @param existingUsers - list of existing users retrieved from the server
 */
function importUsers(userMap, existingUsers) {
    logger.info('existing users: ', existingUsers);
    existingUsers.forEach(function(user) {
        var userToUpdate = userMap[user.username];
        if(userToUpdate !== undefined) {
            userToUpdate.id = user.id;
            updateUser(userToUpdate);
            delete userMap[user.username];
        }
    });

    Object.keys(userMap).forEach(function(key) {
        createUser(userMap[key]);
    })
}

/**
 * Update a specific user.
 * 
 * @param user - the user object, updated with the id retreived from the server.
 */
function updateUser(user) {

    if(user.patronGroup !== undefined) {
        user.patronGroup = patronGroups[user.patronGroup];
    }

    if(user.personal !== undefined && user.personal.preferredContactTypeId !== undefined) {
        user.personal.preferredContactTypeId = preferredContactTypes[user.personal.preferredContactTypeId];
    }

    var updateOptions = {
        method: 'PUT',
        protocol: folioProtocol,
        host: folioHost,
        port: folioPort,
        path: '/users/' + user.id,
        headers: {
            'X-Okapi-Tenant': folioTenant,
            'Content-type': 'application/json',
            'Accept': 'text/plain',
            'x-okapi-token': authToken
        }
    }

    var json = JSON.stringify(user);

    var req = http.request(updateOptions, function(response) {
        logger.info('User update status: ' + user.username, response.statusCode);
        let userUpdateResult = '';
        response.on('data', (chunk) => { userUpdateResult += chunk; });
        response.on('end', () => {
            try {
                if(response.statusCode > 299 || response.statusCode < 200) {
                    logger.warn('Failed to update user with username: ' + user.username , userUpdateResult);
                }
            } catch (e) {
                logger.error('Failed to update user with username: ' + user.username + ' Reason: ', e.message);
            }
        });
    }).on('error', (e) => {
        logger.error('Failed to update user with username: ' + user.username, e.message);
    });

    req.write(json);
    req.end();

}

/**
 * Create a new user.
 * 
 * @param user - the user object to create. If the user id is not specified, the id will be the username for now.
 */
function createUser(user) {
    if(user.id === undefined) {
        user.id = user.username;
    }

    if(user.patronGroup !== undefined) {
        user.patronGroup = patronGroups[user.patronGroup];
    }

    if(user.personal !== undefined && user.personal.preferredContactTypeId !== undefined) {
        user.personal.preferredContactTypeId = preferredContactTypes[user.personal.preferredContactTypeId];
    }

    var createOptions = {
        method: 'POST',
        protocol: folioProtocol,
        host: folioHost,
        port: folioPort,
        path: '/users',
        headers: {
            'X-Okapi-Tenant': folioTenant,
            'Content-type': 'application/json',
            'Accept': 'text/plain',
            'x-okapi-token': authToken
        }
    }

    var json = JSON.stringify(user);

    var req = http.request(createOptions, function(response) {
        logger.info('User create status: ' + user.username, response.statusCode);
        let userCreateResult = '';
        response.on('data', (chunk) => { userCreateResult += chunk; });
        response.on('end', () => {
            try {
                if(response.statusCode > 299 || response.statusCode < 200) {
                    logger.warn('Failed to create user with name: ' + user.username, userCreateResult);
                } else {
                    createCredentials(user);
                }
            } catch (e) {
                logger.error(e.message);
            }
        });
    }).on('error', (e) => {
        logger.error('Failed to create user with username: ' + user.username, e.message);
    });

    req.write(json);
    req.end();
}

/**
 * Add username + empty password for user.
 * 
 * @param user - the saved user - only the username will be used for now
 */
function createCredentials(user) {
    var credentialOptions = {
        method: 'POST',
        protocol: folioProtocol,
        host: folioHost,
        port: folioPort,
        path: '/authn/credentials',
        headers: {
            'X-Okapi-Tenant': folioTenant,
            'Content-type': 'application/json',
            'Accept': 'text/plain',
            'x-okapi-token': authToken
        }
    }

    var json = JSON.stringify(
        {
            'username' : user.username,
            'password': ''
        }
    );

    var req = http.request(credentialOptions, function(response) {
        logger.info('User credentials creation status: ' + user.username, response.statusCode);
        let userCreateResult = '';
        response.on('data', (chunk) => { userCreateResult += chunk; });
        response.on('end', () => {
            try {
                if(response.statusCode > 299 || response.statusCode < 200) {
                    logger.warn('Failed to create user credentials for user with name: ' + user.username, userCreateResult);
                /*} else {
                    createPermissions(user);*/
                }
            } catch (e) {
                logger.error('Failed to save credentials for user with name: ' + user.username + ' Reason: ', e.message);
            }
        });
    }).on('error', (e) => {
        logger.error('Failed to add user credentials for user: ' + user.username, e.message);
    });

    req.write(json);
    req.end();

}

/**
 * Get patron group list and create a name-id map.
 * Start user data processing.
 */
function getPatronGroups() {
     var patronGroupRequest = {
        method: 'GET',
        protocol: folioProtocol,
        host: folioHost,
        port: folioPort,
        path: '/groups',
        headers: {
            'X-Okapi-Tenant': folioTenant,
            'Accept': 'application/json',
            'x-okapi-token': authToken
        }
    }

    var req = http.get(patronGroupRequest, function(response) {
        logger.info('Patron group list request status: ', response.statusCode);
        let groupResult = '';
        response.on('data', (chunk) => { groupResult += chunk; });
        response.on('end', () => {
            try {
                if(response.statusCode > 299 || response.statusCode < 200) {
                    logger.warn('Failed to list patron groups.', groupResult);
                } else {
                    var groupList = JSON.parse(groupResult);
                    groupList.usergroups.forEach(function(group) {
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

    var addressTypeRequest = {
        method: 'GET',
        protocol: folioProtocol,
        host: folioHost,
        port: folioPort,
        path: '/addresstypes',
        headers: {
            'X-Okapi-Tenant': folioTenant,
            'Accept': 'application/json',
            'x-okapi-token': authToken
        }
    }

    var req = http.get(addressTypeRequest, function(response) {
        logger.info('Address type list request status: ', response.statusCode);
        let addressResult = '';
        response.on('data', (chunk) => { addressResult += chunk; });
        response.on('end', () => {
            try {
                if(response.statusCode > 299 || response.statusCode < 200) {
                    logger.warn('Failed to list address types.', addressResult);
                } else {
                    logger.trace('Address types: ', addressResult);
                    var addressTypeList = JSON.parse(addressResult);
                    addressTypeList.forEach(function(addressType) {
                        addressTypes[addressType.addressType] = addressType.id;
                    });
                }
            } catch (e) {
                logger.error('Failed to get address type list. Reason: ',e.message);
            }
            getPatronGroups();
        });
    }).on('error', (e) => {
        logger.error('Failed to list address types.', e.message);
    });

}

/*
function createPermissions() {
    var createPermissions = {
        method: 'POST',
        protocol: folioProtocol,
        host: folioHost,
        port: folioPort,
        path: '/perms/permissions',
        headers: {
            'X-Okapi-Tenant': folioTenant,
            'Content-type': 'application/json',
            'Accept': 'text/plain',
            'x-okapi-token': authToken
        }
    }

    var json = JSON.stringify({
        'permissionName': '',
        'displayName': '',
        'id': '',
        'description': '',
        'tags': [''],
        'subPermissions': [''],
        'mutable': 'false',
        'visible': 'false'
    });

    var req = http.request(createPermissions, function(response) {
        logger.info('User permissions creation status: ' + user.username, response.statusCode);
        let userCreateResult = '';
        response.on('data', (chunk) => { userCreateResult += chunk; });
        response.on('end', () => {
            try {
                if(response.statusCode > 299 || response.statusCode < 200) {
                    logger.warn('Failed to create user permissions for user with name: ' + user.username, userCreateResult);
                }
            } catch (e) {
                logger.error(e.message);
            }
        });
    });

    req.write(json);
    req.end();
}
*/

module.exports = function(configUrl) {
    return startImport(configUrl);
}