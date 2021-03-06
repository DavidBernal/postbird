var SqlExporter = require('../../lib/sql_exporter');
var pgEscape = require('pg-escape');

var TABLE_TYPES = {
  VIEW: 'VIEW',
  TABLE: 'BASE TABLE',
  MAT_VIEW: 'MATERIALIZED VIEW',
  FOREIGN_TABLE: 'FOREIGN TABLE'
};


class Table extends ModelBase {
  /*::
  tableType: string
  schema: string
  table: string
  static types: any
  */

  static create (schema, tableName, options /*:: ?: any */) {

    if (options == undefined) {
      options = {};
    }

    var columns = "()";
    if (!options.empty) {
      columns = "(id SERIAL PRIMARY KEY)";
    }

    var schemaSql = schema && schema != '' ? `"${schema}".` : '';
    var sql = `CREATE TABLE ${schemaSql}"${tableName}" ${columns};`;

    return ModelBase.q(sql).then(res => {
      return Promise.resolve(new Model.Table(schema, tableName));
    }).catch((error) => {
      return Promise.reject((error));
    });
  }

  constructor (schema, tableName, tableType /*:: ?: string */) {
    super();
    this.tableType = tableType || null;

    this.schema = schema;
    this.table = tableName;
  }

  rename (newName) {
    return this.getTableType().then(tableType => {
      var sql;
      if (tableType == TABLE_TYPES.VIEW) {
        sql = `ALTER VIEW ${this.sqlTable()} RENAME TO "${newName}"`;
      } else if (tableType == TABLE_TYPES.MAT_VIEW) {
        sql = `ALTER MATERIALIZED VIEW ${this.sqlTable()} RENAME TO "${newName}"`;
      } else if (tableType == TABLE_TYPES.FOREIGN_TABLE) {
        sql = `ALTER FOREIGN TABLE ${this.sqlTable()} RENAME TO "${newName}"`;
      } else if (tableType == TABLE_TYPES.TABLE) {
        sql = `ALTER TABLE ${this.sqlTable()} RENAME TO "${newName}"`;
      } else {
        throw new Error(`Can not rename ${tableType} (not supported or not implemented)`);
      }

      return this.q(sql).then((res) => {
        this.table = newName;
        return Promise.resolve(res);
      });
    });
  }

  remove () {
    return this.getTableType().then(tableType => {

      if (tableType == TABLE_TYPES.VIEW) {
        return this.removeView();
      } else if (tableType == TABLE_TYPES.MAT_VIEW) {
        return this.removeMatView();
      } else if (tableType == TABLE_TYPES.FOREIGN_TABLE) {
        return this.removeFereignTable();
      } else {
        return this.q(`DROP TABLE ${this.sqlTable()}`);
      }
    });
  }

  drop () {
    return this.remove();
  }

  removeView () {
    var sql = `DROP VIEW ${this.sqlTable()}`;
    return this.q(sql);
  }

  removeMatView () {
    var sql = `DROP MATERIALIZED VIEW ${this.sqlTable()}`;
    return this.q(sql);
  }

  removeFereignTable () {
    return this.q(`DROP FOREIGN TABLE ${this.sqlTable()}`);
  }

  async isMatView () {
    return (await this.getTableType()) == "MATERIALIZED VIEW";
  }

  async isView () {
    return (await this.getTableType()) == "VIEW";
  }

  async getTableType () {
    if (this.tableType !== undefined && this.tableType !== null) {
      return Promise.resolve(this.tableType);
    }

    var sql;
    if (this.connection().server.supportMatViews()) {
      sql = `
        SELECT table_schema, table_name, table_type
        FROM information_schema.tables
        WHERE table_schema = '${this.schema}' AND table_name = '${this.table}'
        UNION
        SELECT schemaname as table_schema, matviewname as table_name, 'MATERIALIZED VIEW' as table_type
        FROM pg_matviews
        WHERE schemaname = '${this.schema}' AND matviewname = '${this.table}'
      `
    } else {
      sql = `
        SELECT table_schema, table_name, table_type
        FROM information_schema.tables
        WHERE table_schema = '${this.schema}' AND table_name = '${this.table}'
      `
    }

    var data = await this.q(sql);
    this.tableType = data.rows && data.rows[0] && data.rows[0].table_type;
    return this.tableType;
  }

  getStructure () {
    return this.isMatView().then(isMatView => {
      if (isMatView) {
        return this._getMatViewStructure();
      } else {
        return this._getTableStructure();
      }
    });
  }

  async _getTableStructure () {
    var sql = `
      SELECT
        a.attname as column_name,
        NOT a.attnotnull as is_nullable,
        information_schema._pg_char_max_length(information_schema._pg_truetypid(a.*, t.*), information_schema._pg_truetypmod(a.*, t.*)) as character_maximum_length,
        pg_catalog.format_type(a.atttypid, a.atttypmod) as data_type,
        (SELECT substring(pg_catalog.pg_get_expr(d.adbin, d.adrelid) for 128)
         FROM pg_catalog.pg_attrdef d
         WHERE d.adrelid = a.attrelid AND d.adnum = a.attnum AND a.atthasdef) as column_default,
        a.attnotnull, a.attnum,
        (SELECT c.collname FROM pg_catalog.pg_collation c, pg_catalog.pg_type t
         WHERE c.oid = a.attcollation AND t.oid = a.atttypid AND a.attcollation <> t.typcollation) AS attcollation
      FROM pg_catalog.pg_attribute a
      JOIN pg_type t on t.oid = a.atttypid
      WHERE
        a.attrelid = (
          select c.oid from pg_catalog.pg_class c
          LEFT JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          where c.relname = '${this.table}' and n.nspname = '${this.schema}' limit 1
        ) AND
        a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum;
    `;

    var data = await this.q(sql);
    var hasOID = await this.hasOID();

    if (hasOID) {
      data.rows.unshift({
        column_name: "oid",
        data_type: "oid",
        column_default: null,
        udt_name: "oid"
      });
    }

    var rows = await this.getPrimaryKey();
    var keys = rows.map((r) => {
      return r.attname;
    });

    data.rows.forEach((row) => {
      row.is_primary_key = keys.indexOf(row.column_name) != -1;
    });

    return data.rows;
  }

  async _getMatViewStructure () {
    var sql = `select attname as column_name, typname as udt_name, attnotnull, typdefault as column_default
               from pg_attribute a
               join pg_class c on a.attrelid = c.oid
               join pg_type t on a.atttypid = t.oid
               where relname = '${this.table}' and attnum >= 1;`;

    var data = await this.q(sql);

    data.rows.forEach((row) => {
      row.is_nullable = row.attnotnull ? "NO" : "YES";
    });

    return data.rows;
  }

  async hasOID () {
    //var sql = "select relhasoids from pg_catalog.pg_class where relname = '%s'";
    var sql = `SELECT relhasoids FROM pg_catalog.pg_class, pg_catalog.pg_namespace n
      WHERE n.oid = pg_class.relnamespace AND nspname = '${this.schema}' AND relname = '${this.table}'`

    var data = await this.q(sql);
    return data && data.rows[0] && data.rows[0].relhasoids;
  }

  async getColumnTypes () /*: Promise<any> */ {
    if (await this.isMatView()) {
      return this._matview_getColumnTypes();
    } else {
      return this._table_getColumnTypes();
    }
  }

  async _table_getColumnTypes () {
    var sql = `
      SELECT
        a.attname as column_name,
        pg_catalog.format_type(a.atttypid, a.atttypmod) as data_type,
        t.typname as udt_name,
        NOT a.attnotnull as is_nullable,
        (SELECT substring(pg_catalog.pg_get_expr(d.adbin, d.adrelid) for 128)
         FROM pg_catalog.pg_attrdef d
         WHERE d.adrelid = a.attrelid AND d.adnum = a.attnum AND a.atthasdef) as column_default
      FROM pg_catalog.pg_attribute a
      JOIN pg_type t on t.oid = a.atttypid
      WHERE
        a.attrelid = (
          select c.oid from pg_catalog.pg_class c
          LEFT JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          where c.relname = '${this.table}' and n.nspname = '${this.schema}' limit 1
        ) AND
        a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum;
    `;

    var data = await this.q(sql)
    var types = {};
    if (await this.hasOID()) {
      types["oid"] = {
        column_name: "oid",
        data_type: "oid",
        column_default: null,
        udt_name: "oid"
      };
    }

    if (data.rows) {
      data.rows.forEach((row) => {
        types[row.column_name] = row;
        types[row.column_name].real_format = row.udt_name;
      });
    }

    return types;
  }

  async _matview_getColumnTypes () {
    var columns = await this._getMatViewStructure();
    var types = {};
    columns.forEach((row) => {
      types[row.column_name] = row;
      types[row.column_name].real_format = row.udt_name;
    });
    return types;
  }

  async getColumns (name /*:: ?: string */) {
    if (await this.isMatView()) {
      return this._matview_getColumns();
    } else {
      return this._table_getColumns(name);
    }
  }

  _table_getColumns (name) {
    var sql = "select * from information_schema.columns where table_schema = '%s' and table_name = '%s' %s;";
    var cond = name ? " and column_name = '" + name + "'" : '';

    return this.q(sql, this.schema, this.table, cond).then(rows => {
      return Promise.resolve(rows.rows);
    });
  }

  _matview_getColumns () {
    return this._getMatViewStructure();
  }

  // For tests only
  getColumnNames () {
    return this.getColumns().then(rows => {
      var names = rows.map(c => { return c.column_name; });
      return Promise.resolve(names);
    });
  }

  getPrimaryKey () {
    var sql = `SELECT pg_attribute.attname
      FROM pg_index, pg_class, pg_attribute
      WHERE
        pg_class.oid = '${this.sqlTable()}'::regclass AND
        indrelid = pg_class.oid AND
        pg_attribute.attrelid = pg_class.oid AND
        pg_attribute.attnum = any(pg_index.indkey)
        AND indisprimary;`;

    return this.q(sql).then(data => {
      return Promise.resolve(data.rows);
    });
  }

  getColumnObj (name) {
    return this.getColumns(name).then(data => {
      var row = new Model.Column(data[0].column_name, data[0]);
      row.table = this;
      return Promise.resolve(row);
    });
  }

  addColumnObj (column) {
    column.table = this;
    return column.create();
  }

  async getRows (offset, limit, options) {
    if (!offset) offset = 0;
    if (!limit) limit = 100;
    if (!options) options = {};

    var sysColumns = [];
    if (options.with_oid) sysColumns.push('oid');
    if (!await this.isView()) sysColumns.push('ctid');

    //sysColumns = sysColumns.join(", ") + (sysColumns.length ? "," : "");
    var selectColumns = sysColumns.concat(['*']);
    if (options.extraColumns) {
      selectColumns = selectColumns.concat(options.extraColumns);
    }

    var orderSql = "";
    if (options.sortColumn) {
      var direction = options.sortDirection || 'asc';
      orderSql = ` ORDER BY "${options.sortColumn}" ${direction}`;
    }

    var condition = "";
    if (options.conditions) {
      condition = `WHERE ${options.conditions.join(" AND ")}`;
    }

    var sql = `SELECT ${selectColumns.join(', ')} FROM ${this.sqlTable()} ${condition} ${orderSql} LIMIT ${limit} OFFSET ${offset}`;

    return this.q(sql).then(data => {
      if (data) {
        data.limit = limit;
        data.offset = offset;
      }
      // remove columns if we selected extra columns
      if (data && options.extraColumns) {
        data.fields.splice(data.fields.length - options.extraColumns.length, options.extraColumns.length);
      }
      return Promise.resolve(data);
    });
  }

  async getTotalRows () {
    var sql = `SELECT count(*) AS rows_count FROM ${this.sqlTable()}`;
    var data = await this.q(sql);
    return parseInt(data.rows[0].rows_count, 10);
  }

  // unused
  async getTotalRowsEstimate () {
    var sql = `SELECT reltuples::bigint AS estimate
      FROM   pg_class
      WHERE  oid = '${this.sqlTable()}'::regclass`

    return (await this.q(sql)).rows[0].estimate;
  }

  insertRow (values) {
    if (Array.isArray(values)) {
      var sql = `INSERT INTO ${this.sqlTable()} VALUES (%s)`;

      var safeValues = values.map((val) => {
        return "'" + val.toString() + "'";
      }).join(", ");

      return this.q(sql, safeValues);
    } else {
      var columns = Object.keys(values).map(col => {
        return `"${col}"`;
      });
      var sql = `INSERT INTO ${this.sqlTable()} (${columns.join(", ")}) VALUES (%s)`;
      var safeValues = Object.values(values).map(val => {
        return "'" + val.toString() + "'";
      }).join(", ");

      return this.q(sql, safeValues);
    }
  }

  deleteRowByCtid (ctid) {
    var sql = `DELETE FROM ${this.sqlTable()} WHERE ctid='${ctid}'`;
    return this.q(sql);
  }

  getSourceSql (callback) {
    var exporter = new SqlExporter({debug: true});
    // TODO: include schema
    exporter.addArgument('--table=' + this.sqlTable());
    exporter.addArgument("--schema-only");
    exporter.addArgument('--no-owner');

    return new Promise((resolve, reject) => {
      exporter.doExport(ModelBase.connection(), (result, stdout, stderr, process) => {
        if (!result) {
          log.error("Run pg_dump failed");
          log.error(stderr);
        }
        stdout = stdout.toString();
        stdout = stdout.replace(/\n*^SET .+$/gim, "\n"); // remove SET ...;
        stdout = stdout.replace(/(^|\n|\r)(\-\-\r?\n\-\-.+\r?\n\-\-)/g, "\n"); // remove comments
        stdout = stdout.replace(/^\-\- Dumped from .+$/m, "\n"); // remove 'Dumped from ...'
        stdout = stdout.replace(/^\-\- Dumped by .+$/m, "\n"); // remove 'Dumped by ...'
        stdout = stdout.replace(/(\r?\n){2,}/gim, "\n\n"); // remove extra new lines
        stdout = stdout.trim(); // remove padding spaces

        // some views craeted by extensions can't be dumped
        if (stdout.length == 0) {
          this.getTableType().then(tableType => {

            if (tableType == 'VIEW') {
              this.q(`select pg_get_viewdef('${this.schema}.${this.table}', true);`, (defFesult, error) => {
                var source = defFesult.rows[0].pg_get_viewdef;
                callback && callback(defFesult.rows[0].pg_get_viewdef, error && error.message);
                error ? reject(error) : resolve(source);
              });
            } else {
              callback && callback(stdout, result ? undefined : stderr);
              result ? resolve(stdout) : reject(stderr);
            }
          });
        } else {
          callback && callback(stdout, result ? undefined : stderr);
          result ? resolve(stdout) : reject(stderr);
        }
      });
    });
  }

  async diskSummary () {
    var sql = `
      select
        pg_size_pretty(pg_total_relation_size(C.oid)) AS "total_size",
        reltuples as estimate_count,
        relkind
      FROM pg_class C
      LEFT JOIN pg_namespace N ON (N.oid = C.relnamespace)
      WHERE
        nspname = '${this.schema}' AND relname = '${this.table}'
    `;

    /*
      if (!result) {
        callback("error getting talbe info", '', '', error);
        return;
      }
    */

    var result = await this.q(sql);

    var row = result.rows[0];
    var type = row.relkind;
    // TODO: dry
    // https://www.postgresql.org/docs/10/static/catalog-pg-class.html
    switch (row.relkind) {
      case "r": type = "table"; break;
      case "i": type = "index"; break;
      case "s": type = "sequence"; break;
      case "v": type = "view"; break;
      case "m": type = "materialized view"; break;
      case "c": type = "composite type"; break;
      case "t": type = "TOAST table"; break;
      case "f": type = "foreign table"; break;
      case "p": type = "partitioned table"; break;
    }

    return {
      type: type,
      estimateCount: row.estimate_count,
      diskUsage: row.total_size
    };
  }

  truncate (cascade, callback) {
    var sql = `truncate table ${this.sqlTable()} ${cascade ? "CASCADE" : ""};`;
    return this.q(sql, (data, error) => {
      callback && callback(data, error);
    });
  }

  getConstraints () {
    var sql = `
      SELECT *, pg_get_constraintdef(oid, true) as pretty_source
      FROM pg_constraint WHERE conrelid = '${this.sqlTable()}'::regclass
    `;
    return this.q(sql);
  }

  dropConstraint (constraintName, callback) {
    var sql = `ALTER TABLE ${this.sqlTable()} DROP CONSTRAINT ${constraintName};`;
    this.q(sql, (data, error) => {
      callback(data, error);
    });
  }

  sqlTable () {
    return `"${this.schema}"."${this.table}"`;
  }

  refreshMatView () {
    return this.q(`REFRESH MATERIALIZED VIEW ${this.sqlTable()}`);
  }

  updateValue (ctid, field, value, isNull) {
    var sql;
    if (isNull) {
      sql = `UPDATE ${this.sqlTable()} SET "${field}" = NULL WHERE ctid = '${ctid}';`;
    } else {
      sql = pgEscape(`UPDATE ${this.sqlTable()} SET "${field}" = %L WHERE ctid = '${ctid}';`, value);
    }

    return this.q(sql);
  }
}

Table.types = TABLE_TYPES;

/*::
declare var Table__: typeof Table
*/

module.exports = Table;
