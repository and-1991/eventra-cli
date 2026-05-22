import { Eventra } from "@eventra_dev/eventra-sdk";

const tracker = new Eventra({ apiKey: "test-fixture-key" });

/* eslint-disable */


function Injectable(): any {
  return () => {};
}

function Controller(): any {
  return () => {};
}

function Get(): any {
  return () => {};
}

function Post(): any {
  return () => {};
}

// ===== service =====
@Injectable()
export class TestService {
  run() {
    tracker.track("nest_event");
  }

  async asyncRun() {
    tracker.track("async_event");
  }

  arrow = () => {
    tracker.track("arrow_event");
  };
}

// ===== controller =====
@Controller()
export class TestController {
  @Get()
  get() {
    tracker.track("get_event");
  }

  @Post()
  post() {
    tracker.track("post_event");
  }

  nested() {
    if (true) {
      tracker.track("nested_event");
    }
  }
}

// ===== function =====
function service() {
  tracker.track("function_event");
}

// ===== class =====
class AnotherService {
  run() {
    tracker.track("class_event");
  }
}

// ===== direct =====
tracker.track("direct_event");
