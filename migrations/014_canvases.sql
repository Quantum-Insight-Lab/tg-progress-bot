-- Канвас (E-7): одно rich-сообщение в топике исполнителя на дату.
-- Поля: id, проект, исполнитель, топик, сообщение, дата.
-- Ключ — id. Одно сообщение на проект, исполнителя и дату (L-8, INV-23).

CREATE TABLE canvases (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  assignee_id uuid NOT NULL,
  topic_id bigint NOT NULL,
  message_id bigint NOT NULL,
  canvas_date date NOT NULL,
  CONSTRAINT canvases_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects (id),
  CONSTRAINT canvases_assignee_id_fkey FOREIGN KEY (assignee_id) REFERENCES users (id),
  CONSTRAINT canvases_topic_id_positive CHECK (topic_id > 0),
  CONSTRAINT canvases_message_id_positive CHECK (message_id > 0),
  CONSTRAINT canvases_project_assignee_date_unique UNIQUE (project_id, assignee_id, canvas_date)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE canvases TO journal_app;
