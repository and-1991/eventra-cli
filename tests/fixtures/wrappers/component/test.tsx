/* eslint-disable */

declare const Button: any;
declare const TrackedButton: any;
declare const MyButton: any;

const eventName = "variable_event";

export default function WrapperTest() {
  return (
    <>
      {/* basic */}
      <Button event="wrapper_button" />

      {/* expression */}
      <Button event={"expression_button"} />

      {/* nested */}
      <div>
        <Button event="nested_button" />
      </div>

      {/* fragment */}
      <>
        <Button event="fragment_button" />
      </>

      {/* conditional */}
      {true && (
        <Button event="conditional_button" />
      )}

      {/* ternary */}
      {true
        ? <Button event="ternary_a_button" />
        : <Button event="ternary_b_button" />
      }

      {/* array */}
      {[
        <Button key="1" event="array_1" />,
        <Button key="2" event="array_2" />
      ]}

      {/* wrapper components */}
      <TrackedButton event={eventName} />
      <MyButton event="my_button" />

      {/* multiline */}
      <Button
        event="multiline_button"
      />

      {/* deep nested */}
      <div>
        <section>
          <Button event="deep_nested" />
        </section>
      </div>
    </>
  );
}
