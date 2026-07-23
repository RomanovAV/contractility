# Полный тест Contractility на целевой машине

Эта инструкция рассчитана на закрытый контур без выполнения `npm install`.
Проект переносится через Git, а команды запускаются из корня клонированного
репозитория Contractility.

Обозначения в примерах:

- `/opt/contractility` — пример каталога приложения на целевой машине
  (замените его на разрешённый каталог, доступный текущему пользователю);
- `/secure/incoming` — каталог с договором, подписанными дополнительными
  соглашениями, новой редакцией DOCX и экспортом из браузера;
- `CASE_ID` и `RUN_ID` — идентификаторы из вывода соответствующих команд;
- `document-1`, `document-2` и далее — идентификаторы документов из
  `inputs.signedDocuments` файла `*.formation-request.json`.

Не используйте тестовые документы с персональными или коммерческими данными,
если передача их содержимого настроенным моделям GigaCode не разрешена
политикой организации.

## 1. Клонирование репозитория на целевой машине

```bash
git --version
mkdir -p /opt
cd /opt
git clone --branch master --single-branch \
  git@github.com:RomanovAV/contractility.git
cd /opt/contractility
```

Если для целевой машины настроен HTTPS-доступ вместо SSH:

```bash
git clone --branch master --single-branch \
  https://github.com/RomanovAV/contractility.git
cd contractility
```

Зафиксируйте точную версию кода, на которой выполняется тест:

```bash
git status --short
git branch --show-current
git rev-parse HEAD
git log -1 --date=iso --format='%H%n%ad%n%an%n%s'
```

Перед началом теста `git status --short` не должен показывать локальных
изменений. Для воспроизводимого приёмочного прогона используйте заранее
согласованный commit SHA или подписанный тег, а не произвольное текущее
состояние ветки.

## 2. Проверка системных зависимостей

```bash
node --version
gigacode --version
zip -v
unzip -v
soffice --version
```

Требуется Node.js 22 или новее. GigaCode CLI должен быть уже установлен,
настроен и авторизован в разрешённом модельном контуре.

## 3. Настройка моделей

```bash
cp config/target.example.json config/target.json
```

Откройте `config/target.json` и замените все значения `MODEL_*` реальными
идентификаторами моделей GigaCode:

- `models.producer` — формирование первого кандидата;
- `models.synthesizer` — арбитраж замечаний и внесение подтверждённых правок;
- пять `models.reviewers[].model` — независимое ревью.

Должно быть настроено не менее трёх разных моделей. Для полноценного
межмодельного теста рекомендуется назначить разные модели всем пяти
рецензентам, а также отдельные модели producer и synthesizer.

Проверьте системные команды и выполните короткий запрос к каждой уникальной
модели:

```bash
npm run doctor:target -- --config config/target.json --smoke
```

Ожидаемый результат: все строки начинаются с `✓`, включая каждую модель.

## 4. Автоматические тесты и локальный OCR

```bash
npm test
node scripts/doctor.mjs
npm start
```

Откройте в браузере:

```text
http://127.0.0.1:4317
```

В интерфейсе:

1. выберите исходный подписанный договор PDF;
2. добавьте все подписанные дополнительные соглашения PDF в хронологическом
   порядке;
3. отдельно выберите новую редакцию дополнительного соглашения DOCX;
4. дождитесь завершения OCR всех страниц;
5. проверьте порядок документов и исправьте существенные ошибки OCR;
6. скачайте `*.formation-request.json`.

Остановить локальный сервер после экспорта можно сочетанием `Ctrl+C`.

## 5. Подготовка неизменяемого case bundle

Сначала посмотрите идентификаторы и имена документов в запросе:

```bash
node -e '
const fs = require("fs");
const request = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
for (const item of request.inputs.signedDocuments) {
  console.log(`${item.id}\t${item.role}\t${item.file.name}`);
}
' /secure/incoming/contract.formation-request.json
```

Передайте ровно один `--source ID=PATH` для каждого PDF. Первый источник —
исходный договор, следующие — подписанные дополнительные соглашения:

```bash
npm run target -- prepare \
  --request /secure/incoming/contract.formation-request.json \
  --draft /secure/incoming/new-edition.docx \
  --source document-1=/secure/incoming/contract.pdf \
  --source document-2=/secure/incoming/agreement-1.pdf \
  --source document-3=/secure/incoming/agreement-2.pdf \
  --out data/cases
```

Добавьте или уберите строки `--source` в соответствии с фактическим комплектом.
Команда повторно проверит SHA-256 всех PDF и DOCX. Из вывода сохраните
`caseDirectory`, например:

```text
/opt/contractility/data/cases/case-0123456789abcdef0123
```

Задайте его для следующих команд:

```bash
CASE_DIR="/opt/contractility/data/cases/CASE_ID"
test -f "$CASE_DIR/case-manifest.json"
```

## 6. Полный запуск с циклическим межмодельным ревью

```bash
npm run target -- run \
  --case "$CASE_DIR" \
  --config config/target.json
```

Команда может выполнить несколько раундов. В каждом раунде пять read-only
рецензентов работают параллельно, затем synthesizer проверяет замечания,
вносит подтверждённые исправления и запускает новый полный раунд ревью.

Из вывода сохраните `runDirectory`, например:

```text
/opt/contractility/data/runs/run-20260723123456-0123abcd
```

```bash
RUN_DIR="/opt/contractility/data/runs/RUN_ID"
npm run target -- status --run "$RUN_DIR"
```

Допустимые результаты автоматической стадии:

- `awaiting-human-approval` — кандидат прошёл автоматическое ревью;
- `blocked` — требуется разбор причины из `state.json` и `consensus.json`;
- `failed` — техническая ошибка, указанная в `state.json`.

Состояния `blocked` и `failed` нельзя подтверждать или финализировать.

## 7. Ручная проверка результата ревью

```bash
cat "$RUN_DIR/state.json"
cat "$RUN_DIR/events.ndjson"
find "$RUN_DIR/rounds" -path '*/reviews/*.json' -print
find "$RUN_DIR/rounds" -name consensus.json -print
```

Просмотрите:

- `rounds/NN/reviews/*.json` — замечания всех пяти рецензентов;
- `rounds/NN/consensus.json` — решение арбитра;
- `rounds/NN/artifacts/current-contract.md` — восстановленную действующую
  редакцию договора;
- `rounds/NN/artifacts/change-register.json` — реестр применённых изменений;
- путь `candidatePath` из `state.json` — DOCX-кандидат, прошедший последний
  раунд.

Для дополнительной визуальной проверки отрисуйте кандидат в PDF:

```bash
CANDIDATE_REL="$(
  node -e \
    'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).candidatePath)' \
    "$RUN_DIR/state.json"
)"
mkdir -p "$RUN_DIR/manual-render"
soffice --headless \
  --convert-to pdf \
  --outdir "$RUN_DIR/manual-render" \
  "$RUN_DIR/$CANDIDATE_REL"
find "$RUN_DIR/manual-render" -maxdepth 1 -type f -name '*.pdf' -print
```

До подтверждения вручную сопоставьте финальный текст с подписанными PDF,
проверьте даты, стороны, реквизиты, номера пунктов, таблицы, сноски,
колонтитулы, нумерацию страниц и все замечания рецензентов.

## 8. Подтверждение проверенных хешей

Выполняйте этот шаг только при состоянии `awaiting-human-approval`.

```bash
CANDIDATE_SHA="$(
  node -e \
    'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).candidateSha256)' \
    "$RUN_DIR/state.json"
)"
FINDINGS_SHA="$(
  node -e \
    'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).findingsSha256)' \
    "$RUN_DIR/state.json"
)"

printf 'Candidate SHA-256: %s\nFindings SHA-256: %s\n' \
  "$CANDIDATE_SHA" "$FINDINGS_SHA"

npm run target -- approve \
  --run "$RUN_DIR" \
  --candidate-sha256 "$CANDIDATE_SHA" \
  --findings-sha256 "$FINDINGS_SHA" \
  --approver "ФИО проверяющего"
```

Файл `approval/approval.json` фиксирует аудиторское подтверждение процесса,
но не является электронной подписью документа.

## 9. Финализация и итоговая проверка

```bash
npm run target -- finalize --run "$RUN_DIR"
npm run target -- verify --run "$RUN_DIR"

cat "$RUN_DIR/final/final-manifest.json"
shasum -a 256 "$RUN_DIR/final/final-additional-agreement.docx"
```

Итоговый файл:

```text
$RUN_DIR/final/final-additional-agreement.docx
```

`verify` должен вернуть `"ok": true`, а SHA-256 файла должен совпасть со
значением `sha256` в `final/final-manifest.json`.

## Критерии успешного полноценного теста

- зафиксирован точный commit SHA чистой рабочей копии;
- `doctor:target --smoke` подтвердил GigaCode CLI и все выбранные модели;
- `npm test` завершился без ошибок;
- browser OCR обработал весь комплект и сформировал formation request;
- `prepare` повторно подтвердил SHA-256 всех исходных файлов;
- producer создал кандидат и обязательные артефакты;
- все пять reviewer-ролей создали отчёты хотя бы в одном раунде;
- synthesis-арбитр сформировал `consensus.json`;
- запуск дошёл до `awaiting-human-approval`;
- человек просмотрел кандидат и подтвердил точные хеши;
- `finalize` создал финальный DOCX и манифест;
- `verify` вернул `"ok": true`;
- финальный DOCX визуально проверен после конвертации в PDF.

## Что сохранить для аудита

Сохраните целиком каталог `$RUN_DIR`, включая:

- `input-manifest.json` и неизменяемые входы;
- `state.json` и `events.ndjson`;
- все каталоги `rounds/`;
- `approval/approval.json`;
- каталог `final/`;
- использованный `config/target.json` без секретов авторизации;
- версии `node`, `gigacode` и `soffice`.
