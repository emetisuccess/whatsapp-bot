class InstanceRegistry {
  constructor() {
    this.instances = new Map();
  }

  create(id, containerId) {
    this.instances.set(id, {
      id,
      containerId,
      status: "starting",
      createdAt: new Date().toISOString(),
    });
  }

  updateStatus(id, status) {
    const inst = this.instances.get(id);
    if (!inst) return;

    this.instances.set(id, {
      ...inst,
      status,
    });
  }

  getAll() {
    return Array.from(this.instances.values());
  }

  get(id) {
    return this.instances.get(id);
  }
}

module.exports = new InstanceRegistry();
