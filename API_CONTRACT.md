# API contract: Student registration and lab group management

Base URL: `http://localhost:3000` for development. The remote backend must use HTTPS.
All bodies are JSON (`Content-Type: application/json`). Dates are ISO 8601 UTC strings.

## Conventions

**Authentication.** Every route except register and login needs `Authorization: Bearer <token>`. Tokens expire after 1 hour. The server reads the account's role and status from the database on every request, so a disabled account stops working immediately, even with a valid token.

**Roles.** `lecturer` and `student`. Accounts created through registration are always `student`. The lecturer account is seeded.

**Errors.** Every error body is `{ "error": "<message or CODE>" }`, sometimes with extra fields.

| Status | Meaning |
|---|---|
| 400 | Validation failed |
| 401 | `Missing token.`, `Invalid or expired token.` or `Account not available.` |
| 403 | `Forbidden.` (wrong role) or a field a student may not change directly |
| 404 | Record not found |
| 409 | Duplicate, version conflict, group full, or request already decided |
| 500 | `Something went wrong.` |

**Student object** (returned by student routes):

```json
{
  "id": 1,
  "studentNumber": "202400001",
  "name": "John Banda",
  "email": "john@school.com",
  "phone": "0971234567",
  "program": "CS",
  "groupId": 2,
  "deleted": 0,
  "version": 3,
  "updatedAt": "2026-10-08T18:36:37.885Z"
}
```

`id` never changes. `studentNumber` is a nine-digit string and keeps leading zeros. `version` increases on every accepted change and is what the app sends as `baseVersion`. The password hash is never returned.

**Validation rules.** Name: trimmed, 2 to 100 characters, letters (including accented) and ordinary punctuation. Student number: exactly nine digits, no spaces. Programme: a code from `GET /api/programmes` (CS, IT, DS). Groups: G01 to G04, capacity at most 15. Passwords: at least 8 characters.

---

## 1. Authentication

| Method | Route | Role | Request body | Responses |
|---|---|---|---|---|
| POST | `/api/auth/register` | public | `email`, `password`, `studentNumber`, `claimCode`; plus `name` and `program` only when the lecturer has not already created this student | **201** `{ id, email, studentId }` · **400** invalid fields or `Invalid claim code or student number.` · **403** `This student record is closed. Contact a lecturer.` · **409** claim code already used, student already has an account, or email already registered |
| POST | `/api/auth/login` | public | `email`, `password` | **200** `{ token }` · **401** `Invalid email or password.` (also returned for disabled accounts) |
| GET | `/api/me` | any | none | **200** `{ id, email, role, studentId }` · **401** |

Registration rules: the claim code must belong to the student number given and be unused. If the lecturer already entered the student, the account links to that profile and no second profile is created. A claim code works once.

## 2. Reference data

| Method | Route | Role | Request | Responses |
|---|---|---|---|---|
| GET | `/api/programmes` | any | none | **200** `[ { code, name } ]` |
| GET | `/api/groups` | any | none | **200** `[ { id, name, capacity, members } ]` (members counts active students only) |

## 3. Student self-service

| Method | Route | Role | Request body | Responses |
|---|---|---|---|---|
| GET | `/api/students/me` | student | none | **200** student object plus `group: { id, name, capacity, members }` (or `null`) · **404** no profile linked · **403** lecturer |
| PUT | `/api/students/me` | student | any of `name`, `program`, `phone` | **200** updated student · **400** validation · **403** if `studentNumber`, `email`, `groupId` or `group` is sent (use a request instead) · **404** |

A student can only ever read or change their own record. The record is chosen from the verified account, never from the URL or body.

## 4. Student requests (lecturer approves)

A request never reserves a place and never changes data by itself. Each student may have only one pending request of each type.

| Method | Route | Role | Request body | Responses |
|---|---|---|---|---|
| POST | `/api/requests/group-change` | student | `groupId` | **201** `{ id, status: "pending", requestedGroup }` · **400** already in that group · **404** group not found · **409** a request is already pending |
| POST | `/api/requests/number-correction` | student | `studentNumber` (nine digits) | **201** `{ id, status: "pending", requestedNumber }` · **400** invalid or unchanged · **409** a request is already pending |
| GET | `/api/requests/mine` | student | none | **200** `{ groupChanges: [...], numberCorrections: [...] }`, each with `id`, `status`, `note`, `createdAt`, `decidedAt` |
| POST | `/api/requests/:type/:id/cancel` | student | none | **200** `{ id, status: "cancelled" }` · **404** no pending request of theirs with this id |
| GET | `/api/requests?status=pending` | lecturer | none | **200** `{ groupChanges: [...], numberCorrections: [...] }` (status: pending, approved, rejected or cancelled) |
| POST | `/api/requests/group-change/:id/approve` | lecturer | none | **200** `{ id, status: "approved", studentId, groupId }` · **404** · **409** `GROUP_FULL` (request stays pending, old group kept), `STUDENT_DELETED`, or `Request is already <status>.` |
| POST | `/api/requests/number-correction/:id/approve` | lecturer | none | **200** `{ id, status: "approved", studentId, studentNumber }` · **404** · **409** `NUMBER_TAKEN` (number unchanged), `STUDENT_DELETED`, or already decided |
| POST | `/api/requests/:type/:id/reject` | lecturer | optional `note` (max 255) | **200** `{ id, status: "rejected" }` · **404** no pending request with this id |

`:type` is `group-change` or `number-correction`.

## 5. Lecturer: students

All routes below need the `lecturer` role (students receive **403**).

| Method | Route | Request | Responses |
|---|---|---|---|
| POST | `/api/students` | `name`, `studentNumber`, `email`, `password`, optional `phone`, `program` | **201** student · **400** validation · **409** number or email already exists (deleted students keep their number reserved) |
| GET | `/api/students` | query: `q` (name, number or email), `program`, `groupId`, `unassigned=true`, `page`, `limit` (max 100) | **200** `{ total, page, pages, data: [student] }`. Filters combine with AND. |
| GET | `/api/students/:id` | none | **200** student · **404** |
| PUT | `/api/students/:id` | any of `name`, `studentNumber`, `email`, `phone`, `program`, `password`; optional `baseVersion` | **200** student · **400** · **404** · **409** `{ error: "VERSION_CONFLICT", current: student }` when `baseVersion` is stale, or duplicate number/email |
| DELETE | `/api/students/:id` | none | **204** · **404** (also when already deleted) |

Delete is a soft delete. It hides the record, releases the group place once, disables the linked account, and records `deleted_at` and `deleted_by`. Group changes are made through section 6, not through `PUT`.

## 6. Lecturer: groups

| Method | Route | Request body | Responses |
|---|---|---|---|
| POST | `/api/groups` | `name`, optional `capacity` (1 to 15) | **201** `{ id, name, capacity }` · **400** · **409** name exists |
| POST | `/api/groups/:id/assign` | `studentIds: [int]` | **200** `{ assigned }` · **400** · **404** group or a student not found · **409** `GROUP_FULL` (nothing changed) |
| POST | `/api/groups/unassign/:studentId` | none | **200** `{ message }` · **404** |
| POST | `/api/groups/auto-assign` | none | **200** `{ assigned, remainingUnassigned }` |

Every path that puts a student into a group locks the group row first, counts active members, and rejects the whole change if the group would exceed its capacity. A failed assignment leaves the student's previous group in place.

## 7. Sync (lecturer)

### Pull

`GET /api/sync?since=<ISO date>` returns **200** `{ changes: [student], serverTime }`. The list includes soft-deleted records (`deleted: 1`) so devices can remove them. Store `serverTime` and send it as `since` next time. An invalid date returns **400**.

### Push

`POST /api/sync` with up to 100 operations, processed in the order sent:

```json
{
  "operations": [
    {
      "opId": "3f1c2b0e-6c7a-4d5e-9a1b-0c2d3e4f5a6b",
      "type": "update",
      "studentId": 12,
      "baseVersion": 3,
      "payload": { "phone": "0971111111", "groupId": 2 }
    }
  ]
}
```

| Field | Required for | Notes |
|---|---|---|
| `opId` | all | A UUID created once per change. **Reuse the same ID when retrying.** |
| `type` | all | `create`, `update` or `delete` |
| `studentId` | update, delete | Server id of the student |
| `baseVersion` | update | The version the edit was based on. Optional for delete. |
| `payload` | create, update | Fields: `name`, `studentNumber`, `email`, `phone`, `program`, `groupId` (`null` to unassign). Create requires `name`, `studentNumber`, `email`. |

Response: **200** `{ results: [...], serverTime }`, one result per operation, in the same order:

| `status` | Shape | Meaning |
|---|---|---|
| `applied` | `{ opId, status, student }`, plus `replayed: true` for a retry or `alreadyDeleted: true` | The change is saved. `student` holds the new version. |
| `conflict` | `{ opId, status, code: "VERSION_CONFLICT", current: student }` | Someone else changed the record first. Keep the local proposal and show `current` for review. |
| `rejected` | `{ opId, status, code, message }` | The change was refused. Nothing was saved. |

Rejection codes: `VALIDATION`, `GROUP_NOT_FOUND`, `GROUP_FULL`, `DUPLICATE`, `STUDENT_DELETED`, `NOT_FOUND`, `OPERATION_ID_REUSED`.

Other responses: **400** if `operations` is not an array of 1 to 100 items. **403** for students. **500** `{ error, completed: [...] }` if the server fails part-way: operations already saved stay saved, and the app resends the whole batch with the same IDs.

### Retry and conflict rules for the app

1. **Retrying a request (timeout, lost response, server restart):** resend the same `opId` with the same content. The server returns the stored result with `replayed: true` and applies nothing twice.
2. **Same `opId`, different content:** rejected with `OPERATION_ID_REUSED`.
3. **After a `conflict` or `GROUP_FULL`:** the stored result is final for that `opId`. Once the user decides what to do, send a new operation with a **new** `opId` and the current `baseVersion`.
4. **Stale edit of a deleted student:** rejected with `STUDENT_DELETED`. It never recreates the record, and a deleted student's number stays reserved.
5. **Create, edit and delete of the same student while offline:** send them in order. Use the `student.id` from the create result in the later operations. If the student was created and deleted without ever syncing, the app can drop both operations.
6. **Sync accounts:** keep local data and the operation queue per account. Pause sync on a `401` and never replay a queue under another account.
7. **Passwords are never stored on the phone.** Sync creates have no password. The student sets one by registering with a claim code.

## 8. Group occupancy rule

A group holds at most 15 active students. A student is active when `deleted = 0`. Deleting a student releases their place once. Requests, sync, assign and auto-assign all enforce this inside a database transaction with a row lock on the group.
