import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE project_work (
    project_id TEXT NOT NULL,
    work_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version > 0),
    state TEXT NOT NULL,
    work_json TEXT NOT NULL,
    PRIMARY KEY(project_id, work_id)
  )`;
  yield* sql`CREATE TABLE project_work_history (
    project_id TEXT NOT NULL,
    work_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    work_json TEXT NOT NULL,
    PRIMARY KEY(project_id, work_id, version),
    FOREIGN KEY(project_id, work_id) REFERENCES project_work(project_id, work_id)
  )`;
  yield* sql`CREATE TABLE project_work_assignments (
    project_id TEXT NOT NULL,
    work_id TEXT NOT NULL,
    assignment_id TEXT NOT NULL,
    assignment_json TEXT NOT NULL,
    PRIMARY KEY(project_id, work_id, assignment_id),
    FOREIGN KEY(project_id, work_id) REFERENCES project_work(project_id, work_id)
  )`;
  yield* sql`CREATE TABLE project_work_dependencies (
    project_id TEXT NOT NULL,
    work_id TEXT NOT NULL,
    dependency_id TEXT NOT NULL,
    PRIMARY KEY(project_id, work_id, dependency_id),
    FOREIGN KEY(project_id, work_id) REFERENCES project_work(project_id, work_id),
    FOREIGN KEY(project_id, dependency_id) REFERENCES project_work(project_id, work_id)
  )`;
  yield* sql`CREATE TABLE project_work_receipts (
    project_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    input_json TEXT NOT NULL,
    result_json TEXT NOT NULL,
    PRIMARY KEY(project_id, thread_id, request_id)
  )`;
});
