-- Пункт канваса (E-8): задача, нарисованная на канвасе, и её место.
-- Поля: id, канвас, задача, место, канвас переноса.
-- Ключ — id. Кнопки в таблицу не складываются: их рисуют из tasks.status.
-- Какие задачи на канвасе — одна строка на задачу. Порядок — уникальное место.
-- Перенос ссылается на канвас и пуст, пока пункт не перенесён (L-9).

CREATE TABLE canvas_items (
  id uuid PRIMARY KEY,
  canvas_id uuid NOT NULL,
  task_id uuid NOT NULL,
  position integer NOT NULL,
  carried_from_canvas_id uuid,
  CONSTRAINT canvas_items_canvas_id_fkey FOREIGN KEY (canvas_id) REFERENCES canvases (id),
  CONSTRAINT canvas_items_task_id_fkey FOREIGN KEY (task_id) REFERENCES tasks (id),
  CONSTRAINT canvas_items_carried_from_canvas_id_fkey FOREIGN KEY (carried_from_canvas_id) REFERENCES canvases (id),
  CONSTRAINT canvas_items_canvas_task_unique UNIQUE (canvas_id, task_id),
  CONSTRAINT canvas_items_canvas_position_unique UNIQUE (canvas_id, position)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE canvas_items TO journal_app;
