-- MegaPharm — estoque com controle de lote/validade e baixa idempotente.

-- Usuarios internos (auth do painel)
create table if not exists users (
  id            bigint generated always as identity primary key,
  email         text not null unique,
  password_hash text not null,
  name          text,
  role          text not null default 'operator',   -- 'admin' | 'operator'
  created_at    timestamptz not null default now()
);

-- Produtos
create table if not exists products (
  id         bigint generated always as identity primary key,
  sku        text not null unique,
  name       text not null,
  unit       text not null default 'un',
  min_qty    integer not null default 0,            -- limite p/ alerta de estoque baixo
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Lotes: cada lote tem fabricacao, validade e saldo proprio
create table if not exists stock_batches (
  id          bigint generated always as identity primary key,
  product_id  bigint not null references products(id) on delete restrict,
  lote        text not null,
  fabricacao  date,
  validade    date,
  qty_on_hand integer not null default 0 check (qty_on_hand >= 0),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (product_id, lote)
);
-- Ordem FEFO: validade mais proxima primeiro (nulls por ultimo)
create index if not exists idx_batches_fefo
  on stock_batches (product_id, validade asc nulls last, id asc);

-- Razao (ledger) de toda alteracao de estoque
create table if not exists stock_movements (
  id         bigint generated always as identity primary key,
  product_id bigint not null references products(id),
  batch_id   bigint references stock_batches(id),
  order_id   text,                                  -- vincula baixa ao pedido
  qty        integer not null,                      -- negativo = baixa, positivo = entrada
  reason     text not null,                         -- 'sale' | 'entry' | 'adjustment'
  note       text,
  created_by bigint references users(id),
  created_at timestamptz not null default now()
);
create index if not exists idx_movements_order   on stock_movements (order_id);
create index if not exists idx_movements_product on stock_movements (product_id, created_at desc);

-- Guarda de idempotencia: 1 linha por pedido garante baixa 1x so
create table if not exists processed_orders (
  order_id       text primary key,
  payload_hash   text,
  status         text not null default 'processing', -- 'processing' | 'done'
  result         jsonb,
  received_count integer not null default 1,         -- quantos webhooks chegaram p/ este pedido
  created_at     timestamptz not null default now(),
  processed_at   timestamptz
);

-- Alertas: falta de estoque, sku desconhecido, estoque baixo
create table if not exists stock_alerts (
  id            bigint generated always as identity primary key,
  order_id      text,
  product_id    bigint references products(id),
  sku           text,
  type          text not null,                       -- 'shortage' | 'unknown_sku' | 'low_stock'
  requested_qty integer,
  fulfilled_qty integer,
  shortage_qty  integer,
  message       text,
  resolved      boolean not null default false,
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz
);
create index if not exists idx_alerts_unresolved
  on stock_alerts (resolved, created_at desc);
