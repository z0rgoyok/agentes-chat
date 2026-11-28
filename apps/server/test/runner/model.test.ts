import { expect, test } from "bun:test";
import { deviceInfo } from "../../runner/daemon";
import { modelFrom } from "../../runner/model";

test("a computer's model as people say it, from what its firmware writes", () => {
  expect(modelFrom({ vendor: "Dell Inc.", product: "Inspiron 15 3520", version: "1.0" })).toBe("Dell Inspiron 15 3520");
  expect(modelFrom({ vendor: "LENOVO", product: "20XW004KUS", version: "ThinkPad X1 Carbon Gen 9" })).toBe(
    "ThinkPad X1 Carbon Gen 9",
  );
  expect(modelFrom({ vendor: "ASUSTeK COMPUTER INC.", product: "ROG Strix G513QM" })).toBe("ASUS ROG Strix G513QM");
  expect(modelFrom({ vendor: "HP", product: "HP Pavilion Laptop 15-eg0xxx" })).toBe("HP Pavilion Laptop 15-eg0xxx");
  expect(modelFrom({ vendor: "Microsoft Corporation", product: "Surface Laptop 5" })).toBe("Surface Laptop 5");
  expect(modelFrom({ vendor: "Google", product: "Google Compute Engine\n" })).toBe("Google Compute Engine");
  expect(modelFrom({ vendor: "System manufacturer", product: "" })).toBe("");
});

test("the server hears the model only when the runner read one", () => {
  expect(deviceInfo(undefined, undefined, "MacBook Pro")).toMatchObject({ model: "MacBook Pro" });
  expect(deviceInfo()).not.toHaveProperty("model");
});
