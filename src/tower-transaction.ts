/** 先进入当前事务，再设置仅本事务有效的 PG 超时，必须早于账号 upsert/行锁。 */
export async function prepareTowerTransaction(database: any, userId: string) {
  await database.get('xiuxian_sign', { userId }, ['userId'])
  const driver = database.getDriver('xiuxian_sign')
  // SQLite 不提供此能力；PostgresDriver.query 会使用 Minato 当前事务的 session。
  if (typeof driver.postgres === 'function' && typeof driver.query === 'function') {
    await driver.query("SELECT set_config('lock_timeout', '2500ms', true), set_config('statement_timeout', '8000ms', true)")
  }
}
