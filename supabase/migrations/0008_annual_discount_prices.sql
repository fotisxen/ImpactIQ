-- Corrects the yearly base prices to a real 10% discount off monthly×12
-- (the original 0004 values were placeholder round numbers, not actually
-- discounted), and adds the missing annual team-seat price so a Team +
-- yearly checkout with extra seats doesn't attach a monthly recurring
-- line item to a yearly subscription.

insert into public.stripe_prices (key, stripe_price_id) values
  ('individual_year', 'price_1U2pF3CRMaNsxd7Bpn9yNiVq'),
  ('team_year', 'price_1U2pF5CRMaNsxd7BKZSD12G2'),
  ('team_seat_year', 'price_1U2pF6CRMaNsxd7BzOyVhE4X')
on conflict (key) do update set stripe_price_id = excluded.stripe_price_id;
