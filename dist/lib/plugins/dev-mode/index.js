"use strict";

var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");

Object.defineProperty(exports, "__esModule", {
  value: true
});
var _exportNames = {
  deepFreezeWhenDevMode: true,
  RxDBDevModePlugin: true
};
exports.RxDBDevModePlugin = void 0;
exports.deepFreezeWhenDevMode = deepFreezeWhenDevMode;

var _errorMessages = require("./error-messages");

var _checkSchema = require("./check-schema");

Object.keys(_checkSchema).forEach(function (key) {
  if (key === "default" || key === "__esModule") return;
  if (Object.prototype.hasOwnProperty.call(_exportNames, key)) return;
  if (key in exports && exports[key] === _checkSchema[key]) return;
  Object.defineProperty(exports, key, {
    enumerable: true,
    get: function get() {
      return _checkSchema[key];
    }
  });
});

var _checkOrm = require("./check-orm");

var _checkMigrationStrategies = require("./check-migration-strategies");

var _unallowedProperties = require("./unallowed-properties");

Object.keys(_unallowedProperties).forEach(function (key) {
  if (key === "default" || key === "__esModule") return;
  if (Object.prototype.hasOwnProperty.call(_exportNames, key)) return;
  if (key in exports && exports[key] === _unallowedProperties[key]) return;
  Object.defineProperty(exports, key, {
    enumerable: true,
    get: function get() {
      return _unallowedProperties[key];
    }
  });
});

var _checkQuery = require("./check-query");

var _rxError = require("../../rx-error");

var _deepFreeze = _interopRequireDefault(require("deep-freeze"));

/**
 * Deep freezes and object when in dev-mode.
 * Deep-Freezing has the same performaance as deep-cloning, so we only do that in dev-mode.
 * Also we can ensure the readonly state via typescript
 * @link https://developer.mozilla.org/de/docs/Web/JavaScript/Reference/Global_Objects/Object/freeze
 */
function deepFreezeWhenDevMode(obj) {
  // direct return if falsy
  if (!obj) {
    return obj;
  }

  return (0, _deepFreeze["default"])(obj);
}

var DEV_MODE_PLUGIN_NAME = 'dev-mode';
var RxDBDevModePlugin = {
  name: DEV_MODE_PLUGIN_NAME,
  rxdb: true,
  overwritable: {
    isDevMode: function isDevMode() {
      return true;
    },
    deepFreezeWhenDevMode: deepFreezeWhenDevMode,
    tunnelErrorMessage: function tunnelErrorMessage(code) {
      if (!_errorMessages.ERROR_MESSAGES[code]) {
        console.error('RxDB: Error-Code not known: ' + code);
        throw new Error('Error-Code ' + code + ' not known, contact the maintainer');
      }

      return _errorMessages.ERROR_MESSAGES[code];
    }
  },
  hooks: {
    preAddRxPlugin: function preAddRxPlugin(args) {
      /**
       * throw when dev mode is added multiple times
       * because there is no way that this was done intentional.
       * Likely the developer has mixed core and default usage of RxDB.
       */
      if (args.plugin.name === DEV_MODE_PLUGIN_NAME) {
        throw (0, _rxError.newRxError)('DEV1', {
          plugins: args.plugins
        });
      }
    },
    preCreateRxSchema: _checkSchema.checkSchema,
    preCreateRxDatabase: function preCreateRxDatabase(args) {
      (0, _unallowedProperties.ensureDatabaseNameIsValid)(args);
    },
    preCreateRxCollection: function preCreateRxCollection(args) {
      (0, _unallowedProperties.ensureCollectionNameValid)(args);

      if (args.name.charAt(0) === '_') {
        throw (0, _rxError.newRxError)('DB2', {
          name: args.name
        });
      }

      if (!args.schema) {
        throw (0, _rxError.newRxError)('DB4', {
          name: args.name,
          args: args
        });
      }
    },
    preCreateRxQuery: function preCreateRxQuery(args) {
      (0, _checkQuery.checkQuery)(args);
    },
    createRxCollection: function createRxCollection(args) {
      // check ORM-methods
      (0, _checkOrm.checkOrmMethods)(args.statics);
      (0, _checkOrm.checkOrmMethods)(args.methods);
      (0, _checkOrm.checkOrmMethods)(args.attachments); // check migration strategies

      if (args.schema && args.migrationStrategies) {
        (0, _checkMigrationStrategies.checkMigrationStrategies)(args.schema, args.migrationStrategies);
      }
    }
  }
};
exports.RxDBDevModePlugin = RxDBDevModePlugin;
//# sourceMappingURL=index.js.map