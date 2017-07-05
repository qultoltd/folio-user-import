# User import module for FOLIO

## Configuration

You can set the configuration values with npm config 
e.g. npm config set folio-bulk-user-import:FOLIO_PORT 9130

Every setting has a default fallback value.

FOLIO configuration options:
Hostname of OKAPI: FOLIO_HOST
Port of OKAPI: FOLIO_PORT
Protocol of OKAPI: FOLIO_PROTOCOL
Tenant id: FOLIO_TENANT
Username for authentication: FOLIO_USERNAME
Password for username: FOLIO_PASSWORD
File name with user data: FOLIO_FILENAME
Number of users to search for in one query: FOLIO_PAGESIZE
Log file for user import: FOLIO_LOGFILE

## Usage

Use module in a script
    var bulk-import = require('folio-bulk-user-import');
    bulk-import();

optional parameters:
1. user data file name

Run code locally
    cd into directory
    npm install
    npm start

## How it works?

1. Login to FOLIO with credentials set in the configuration values.
2. Get list of address types.
3. Get list of patron groups.
4. Read user data from the configured JSON file.
5. Query FOLIO if users already exist in the system (in batch of FOLIO_PAGESIZE number of users)
6. Decide by the result of the query if the current user have to be inserted or updated in the system.
7. Update existing users.
8. Create non-existing users.