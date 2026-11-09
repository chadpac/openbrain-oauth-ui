CREATE OR REPLACE FUNCTION public.create_next_recurring_task()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  household_timezone TEXT;
  next_due TIMESTAMPTZ;
  next_reminder TIMESTAMPTZ;
BEGIN

  -- Only do this when the task changes INTO completed.
  IF NEW.status <> 'completed'
     OR OLD.status = 'completed'
     OR NEW.recurrence_rule IS NULL
     OR trim(NEW.recurrence_rule) = ''
  THEN
    RETURN NEW;
  END IF;

  SELECT h.timezone
  INTO household_timezone
  FROM public.households h
  WHERE h.id = NEW.household_id;

  household_timezone :=
    COALESCE(household_timezone, 'America/Denver');

  next_due := public.next_recurring_time(
    NEW.due_at,
    NEW.recurrence_rule,
    household_timezone
  );

  next_reminder := public.next_recurring_time(
    NEW.remind_at,
    NEW.recurrence_rule,
    household_timezone
  );

  -- If the rule isn't one we recognize, don't create anything.
  IF next_due IS NULL AND next_reminder IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.family_tasks (
    title,
    description,
    assigned_to,
    category,
    priority,
    status,
    due_at,
    remind_at,
    recurrence_rule,
    visibility,
    household_id,
    created_by,
    assigned_to_user_id
  )
  VALUES (
    NEW.title,
    NEW.description,
    NEW.assigned_to,
    NEW.category,
    NEW.priority,
    'pending',
    next_due,
    next_reminder,
    NEW.recurrence_rule,
    NEW.visibility,
    NEW.household_id,
    NEW.created_by,
    NEW.assigned_to_user_id
  );

  RETURN NEW;
END;
$function$
